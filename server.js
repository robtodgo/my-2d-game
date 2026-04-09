const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.static('public'));

// ---------- Карта ----------
const MAP_WIDTH = 1200;
const MAP_HEIGHT = 800;
const PLAYER_RADIUS = 18;

// Стены (препятствия) – прямоугольники
const walls = [
    { x: 200, y: 150, w: 150, h: 20 },  // горизонтальная
    { x: 400, y: 300, w: 20, h: 200 },  // вертикальная
    { x: 700, y: 500, w: 200, h: 20 },
    { x: 800, y: 200, w: 20, h: 250 },
    { x: 100, y: 600, w: 300, h: 20 },
];

// Игроки и боты
const players = new Map();      // socket.id -> player
const bots = new Map();         // botId -> bot

// Генерация ботов
function createBot(id) {
    return {
        id,
        nickname: `Bot_${id}`,
        color: '#e67e22',
        x: 300 + Math.random() * 600,
        y: 300 + Math.random() * 400,
        targetX: null, targetY: null,
        lastMove: 0
    };
}
for (let i = 1; i <= 3; i++) {
    const bot = createBot(`bot${i}`);
    bots.set(bot.id, bot);
}

// Проверка коллизии круга с прямоугольниками
function collideWithWalls(x, y, r) {
    for (const w of walls) {
        const closestX = Math.max(w.x, Math.min(x, w.x + w.w));
        const closestY = Math.max(w.y, Math.min(y, w.y + w.h));
        const dx = x - closestX;
        const dy = y - closestY;
        if (dx * dx + dy * dy < r * r) return true;
    }
    // Границы карты
    if (x - r < 0 || x + r > MAP_WIDTH || y - r < 0 || y + r > MAP_HEIGHT) return true;
    return false;
}

// Спавн игрока в свободном месте
function findFreePosition() {
    let attempts = 0;
    while (attempts++ < 200) {
        const x = 100 + Math.random() * (MAP_WIDTH - 200);
        const y = 100 + Math.random() * (MAP_HEIGHT - 200);
        if (!collideWithWalls(x, y, PLAYER_RADIUS)) return { x, y };
    }
    return { x: 100, y: 100 };
}

// Движение ботов
function moveBots() {
    for (const bot of bots.values()) {
        // Каждые 2 секунды меняем цель
        if (!bot.targetX || !bot.targetY || Date.now() - bot.lastMove > 2000) {
            bot.targetX = 100 + Math.random() * (MAP_WIDTH - 200);
            bot.targetY = 100 + Math.random() * (MAP_HEIGHT - 200);
            bot.lastMove = Date.now();
        }
        const dx = bot.targetX - bot.x;
        const dy = bot.targetY - bot.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 2) {
            const stepX = (dx / dist) * 1.8;
            const stepY = (dy / dist) * 1.8;
            const newX = bot.x + stepX;
            const newY = bot.y + stepY;
            if (!collideWithWalls(newX, newY, PLAYER_RADIUS)) {
                bot.x = newX;
                bot.y = newY;
            }
        }
    }
    // Отправляем обновлённые позиции ботов всем игрокам
    io.emit('bots update', Array.from(bots.values()).map(b => ({
        id: b.id, nickname: b.nickname, color: b.color, x: b.x, y: b.y
    })));
}

setInterval(moveBots, 50);

io.on('connection', (socket) => {
    console.log(`+ ${socket.id}`);

    socket.on('join', (nickname, callback) => {
        nickname = nickname.trim().substring(0, 12);
        if ([...players.values()].some(p => p.nickname === nickname)) {
            return callback({ ok: false, msg: 'Ник уже занят' });
        }
        const spawn = findFreePosition();
        const player = {
            id: socket.id,
            nickname,
            color: `hsl(${Math.random() * 360}, 70%, 60%)`,
            x: spawn.x, y: spawn.y
        };
        players.set(socket.id, player);
        callback({ ok: true, self: player, players: Array.from(players.values()), bots: Array.from(bots.values()), walls });
        socket.broadcast.emit('player joined', player);
        console.log(`>> ${nickname}`);
    });

    socket.on('move', (data) => {
        const p = players.get(socket.id);
        if (!p) return;
        const newX = data.x, newY = data.y;
        if (!collideWithWalls(newX, newY, PLAYER_RADIUS)) {
            p.x = newX; p.y = newY;
            socket.broadcast.emit('player moved', { id: socket.id, x: p.x, y: p.y });
        }
    });

    socket.on('disconnect', () => {
        const p = players.get(socket.id);
        if (p) {
            players.delete(socket.id);
            io.emit('player left', socket.id);
            console.log(`-- ${p.nickname}`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Among Us 2D server on ${PORT}`));