const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static('public'));

// ---------- Настройки карты ----------
const MAP_WIDTH = 2000;          // Большая карта
const MAP_HEIGHT = 2000;
const TILE_SIZE = 40;            // Размер одного блока (для будущего)

// Игроки
const players = {};

// ---------- Карта блоков (заготовка) ----------
// Для простоты пока массив заполнен null (воздух). Позже можно хранить объекты блоков.
const worldTiles = Array(MAP_WIDTH / TILE_SIZE).fill().map(() => 
    Array(MAP_HEIGHT / TILE_SIZE).fill(null)
);
// Пример: установим несколько блоков земли для теста
for (let i = 10; i < 15; i++) {
    for (let j = 10; j < 15; j++) {
        if (i < MAP_WIDTH/TILE_SIZE && j < MAP_HEIGHT/TILE_SIZE)
            worldTiles[i][j] = { type: 'grass' };
    }
}

function isNicknameTaken(nickname) {
    return Object.values(players).some(p => p.nickname === nickname);
}

function getRandomSpawn() {
    // Спавн подальше от края
    return {
        x: 200 + Math.random() * (MAP_WIDTH - 400),
        y: 200 + Math.random() * (MAP_HEIGHT - 400)
    };
}

io.on('connection', (socket) => {
    console.log(`Новое подключение: ${socket.id}`);

    socket.on('set nickname', (data, callback) => {
        const { nickname, color } = data;
        if (!nickname || nickname.trim() === '') {
            callback({ success: false, message: 'Ник не может быть пустым' });
            return;
        }
        if (isNicknameTaken(nickname)) {
            callback({ success: false, message: 'Ник уже занят' });
            return;
        }

        const spawn = getRandomSpawn();
        players[socket.id] = {
            id: socket.id,
            nickname: nickname.trim(),
            color: color || '#3498db', // цвет по умолчанию
            x: spawn.x,
            y: spawn.y
        };

        callback({ success: true });

        socket.emit('init', {
            self: players[socket.id],
            players: players,
            map: { width: MAP_WIDTH, height: MAP_HEIGHT, tileSize: TILE_SIZE },
            worldTiles: worldTiles   // отправляем карту блоков клиенту
        });

        socket.broadcast.emit('player joined', players[socket.id]);
        console.log(`Игрок ${nickname} вошёл (цвет: ${players[socket.id].color})`);
    });

    socket.on('move', (data) => {
        const player = players[socket.id];
        if (!player) return;

        // Принимаем новую позицию от клиента (предсказание)
        let newX = data.x;
        let newY = data.y;

        // Границы карты
        newX = Math.max(20, Math.min(MAP_WIDTH - 20, newX));
        newY = Math.max(20, Math.min(MAP_HEIGHT - 20, newY));

        player.x = newX;
        player.y = newY;

        // Отправляем подтверждённую позицию всем (включая отправителя для коррекции)
        io.emit('player moved', {
            id: socket.id,
            x: player.x,
            y: player.y
        });
    });

    // Для будущего разрушения блоков
    socket.on('break block', (data) => {
        // data: { tileX, tileY }
        // Проверяем, что блок существует и игрок рядом (потом)
        const tileX = Math.floor(data.tileX);
        const tileY = Math.floor(data.tileY);
        if (tileX >= 0 && tileX < MAP_WIDTH/TILE_SIZE && tileY >= 0 && tileY < MAP_HEIGHT/TILE_SIZE) {
            if (worldTiles[tileX][tileY] !== null) {
                worldTiles[tileX][tileY] = null; // разрушили
                io.emit('block update', { tileX, tileY, block: null });
            }
        }
    });

    socket.on('ping', () => socket.emit('pong'));

    socket.on('disconnect', () => {
        const player = players[socket.id];
        if (player) {
            console.log(`Игрок ${player.nickname} отключился`);
            delete players[socket.id];
            io.emit('player left', socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));