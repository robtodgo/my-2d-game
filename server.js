const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const PIXEL_SIZE = 10;
const COOLDOWN_MS = 5000;
const SAVE_FILE = path.join(__dirname, 'canvas.json');

// Хранилища
const accounts = new Map(); // nickname -> { password }
const players = new Map();  // socket.id -> { nickname, lastDraw }

// Загрузка холста из файла или создание нового
let canvas;
if (fs.existsSync(SAVE_FILE)) {
    try {
        canvas = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    } catch(e) { initEmptyCanvas(); }
} else {
    initEmptyCanvas();
}

function initEmptyCanvas() {
    canvas = Array(CANVAS_WIDTH / PIXEL_SIZE).fill().map(() =>
        Array(CANVAS_HEIGHT / PIXEL_SIZE).fill('#ffffff')
    );
}

// Сохранение холста в файл
function saveCanvas() {
    fs.writeFileSync(SAVE_FILE, JSON.stringify(canvas), 'utf8');
}

// Периодическое сохранение (каждые 10 секунд)
setInterval(saveCanvas, 10000);

io.on('connection', (socket) => {
    console.log(`+ ${socket.id}`);

    socket.on('register', (data, callback) => {
        const { nickname, password } = data;
        if (!nickname || !password) return callback({ ok: false, msg: 'Заполните поля' });
        if (accounts.has(nickname)) return callback({ ok: false, msg: 'Аккаунт уже существует' });
        accounts.set(nickname, { password });
        callback({ ok: true });
    });

    socket.on('login', (data, callback) => {
        const { nickname, password } = data;
        const acc = accounts.get(nickname);
        if (!acc || acc.password !== password) return callback({ ok: false, msg: 'Неверный логин или пароль' });

        // Удаляем старые подключения с таким же ником
        for (const [id, p] of players.entries()) {
            if (p.nickname === nickname) {
                players.delete(id);
                io.to(id).emit('force logout');
                io.sockets.sockets.get(id)?.disconnect();
            }
        }

        players.set(socket.id, { nickname, lastDraw: 0 });
        callback({ ok: true, canvas: canvas, online: getOnlineList() });
        io.emit('online update', getOnlineList());
        console.log(`>> ${nickname}`);
    });

    socket.on('auto login', (nickname, callback) => {
        if (!accounts.has(nickname)) return callback({ ok: false });
        for (const [id, p] of players.entries()) {
            if (p.nickname === nickname) {
                players.delete(id);
                io.to(id).emit('force logout');
                io.sockets.sockets.get(id)?.disconnect();
            }
        }
        players.set(socket.id, { nickname, lastDraw: 0 });
        callback({ ok: true, canvas: canvas, online: getOnlineList() });
        io.emit('online update', getOnlineList());
        console.log(`>> ${nickname} (auto)`);
    });

    socket.on('draw pixel', (data, callback) => {
        const player = players.get(socket.id);
        if (!player) return callback({ ok: false, msg: 'Вы не в игре' });

        const now = Date.now();
        if (now - player.lastDraw < COOLDOWN_MS) {
            const remain = Math.ceil((COOLDOWN_MS - (now - player.lastDraw)) / 1000);
            return callback({ ok: false, msg: `Подождите ${remain} сек` });
        }

        const { x, y, color } = data;
        const gridX = Math.floor(x / PIXEL_SIZE);
        const gridY = Math.floor(y / PIXEL_SIZE);
        if (gridX < 0 || gridX >= canvas.length || gridY < 0 || gridY >= canvas[0].length)
            return callback({ ok: false, msg: 'За пределами холста' });

        canvas[gridX][gridY] = color;
        player.lastDraw = now;
        saveCanvas(); // сохраняем сразу

        io.emit('pixel update', { x: gridX, y: gridY, color });
        callback({ ok: true, cooldown: COOLDOWN_MS });
    });

    socket.on('chat message', (msg) => {
        const player = players.get(socket.id);
        if (!player) return;
        io.emit('chat message', { sender: player.nickname, text: msg });
    });

    socket.on('disconnect', () => {
        const player = players.get(socket.id);
        if (player) {
            players.delete(socket.id);
            io.emit('online update', getOnlineList());
            console.log(`-- ${player.nickname}`);
        }
    });
});

function getOnlineList() {
    return Array.from(players.values()).map(p => p.nickname);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pixel Battle server on ${PORT}`));