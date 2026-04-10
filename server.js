const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const CANVAS_WIDTH = 80;
const CANVAS_HEIGHT = 80;
const DEFAULT_COOLDOWN = 3000; // 3 секунды
const SAVE_FILE = path.join(__dirname, 'canvas.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

// Загрузка аккаунтов
let accounts = new Map();
if (fs.existsSync(ACCOUNTS_FILE)) {
    try {
        accounts = new Map(JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')));
    } catch(e) {}
}

// Холст
let canvas = Array(CANVAS_WIDTH).fill().map(() => Array(CANVAS_HEIGHT).fill('#ffffff'));
if (fs.existsSync(SAVE_FILE)) {
    try {
        canvas = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    } catch(e) {}
}

// Игроки
const players = new Map(); // socket.id -> { nickname, lastDraw, isAdmin }

let globalCooldown = DEFAULT_COOLDOWN;

function saveCanvas() {
    fs.writeFileSync(SAVE_FILE, JSON.stringify(canvas));
}

function saveAccounts() {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify([...accounts]));
}

io.on('connection', (socket) => {
    console.log(`+ ${socket.id}`);

    socket.on('register', (data, callback) => {
        const { nickname, password } = data;
        if (!nickname || !password) return callback({ ok: false, msg: 'Заполните поля' });
        if (accounts.has(nickname)) return callback({ ok: false, msg: 'Ник занят' });
        accounts.set(nickname, password);
        saveAccounts();
        callback({ ok: true });
    });

    socket.on('login', (data, callback) => {
        const { nickname, password } = data;
        if (!accounts.has(nickname) || accounts.get(nickname) !== password) {
            return callback({ ok: false, msg: 'Неверный логин/пароль' });
        }
        // Отключаем старые сессии с этим ником
        for (const [id, p] of players.entries()) {
            if (p.nickname === nickname) {
                players.delete(id);
                io.to(id).emit('force logout');
                io.sockets.sockets.get(id)?.disconnect();
            }
        }
        players.set(socket.id, { nickname, lastDraw: 0, isAdmin: false });
        callback({
            ok: true,
            canvas,
            online: getOnlineList(),
            cooldown: globalCooldown
        });
        io.emit('online update', getOnlineList());
        io.emit('chat message', { sender: '📢', text: `${nickname} вошёл` });
    });

    socket.on('draw pixel', (data, callback) => {
        const player = players.get(socket.id);
        if (!player) return callback({ ok: false, msg: 'Не в игре' });

        const now = Date.now();
        const effectiveCd = player.isAdmin ? 0 : globalCooldown;
        if (now - player.lastDraw < effectiveCd) {
            const remain = Math.ceil((effectiveCd - (now - player.lastDraw)) / 1000);
            return callback({ ok: false, msg: `Подождите ${remain} сек` });
        }

        const { x, y, color } = data;
        if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) {
            return callback({ ok: false, msg: 'За пределами холста' });
        }

        canvas[x][y] = color;
        player.lastDraw = now;
        saveCanvas();

        io.emit('pixel update', { x, y, color });
        callback({ ok: true });
    });

    socket.on('fill', (data, callback) => {
        const player = players.get(socket.id);
        if (!player) return callback({ ok: false, msg: 'Не в игре' });
        // Заливка выполняется на клиенте, сервер только получает массив пикселей
        const { pixels, color } = data;
        for (const p of pixels) {
            if (p.x >= 0 && p.x < CANVAS_WIDTH && p.y >= 0 && p.y < CANVAS_HEIGHT) {
                canvas[p.x][p.y] = color;
            }
        }
        saveCanvas();
        io.emit('batch update', pixels.map(p => ({ x: p.x, y: p.y, color })));
        callback({ ok: true });
    });

    socket.on('chat message', (msg) => {
        const player = players.get(socket.id);
        if (!player) return;
        io.emit('chat message', { sender: player.nickname, text: msg });
    });

    // Админ-команды
    socket.on('admin command', (cmd) => {
        const player = players.get(socket.id);
        if (!player) return;
        const args = cmd.split(' ');
        if (args[0] === '/op' && args[1] === '55332') {
            player.isAdmin = true;
            socket.emit('admin status', true);
            socket.emit('chat message', { sender: '🔓', text: 'Админ-режим активирован' });
        } else if (player.isAdmin) {
            if (args[0] === '/cooldown' && args[1]) {
                const newCd = parseInt(args[1]) * 1000;
                if (!isNaN(newCd) && newCd >= 0) {
                    globalCooldown = newCd;
                    io.emit('cooldown update', globalCooldown);
                    socket.emit('chat message', { sender: '⚙️', text: `Задержка: ${args[1]} сек` });
                }
            } else if (args[0] === '/clear') {
                for (let x = 0; x < CANVAS_WIDTH; x++) {
                    for (let y = 0; y < CANVAS_HEIGHT; y++) {
                        canvas[x][y] = '#ffffff';
                    }
                }
                saveCanvas();
                io.emit('canvas reset', canvas);
                socket.emit('chat message', { sender: '🧹', text: 'Холст очищен' });
            }
        }
    });

    socket.on('upload image', (imageData) => {
        const player = players.get(socket.id);
        if (!player || !player.isAdmin) return;
        // imageData: массив пикселей {x, y, color}
        for (const p of imageData) {
            if (p.x >= 0 && p.x < CANVAS_WIDTH && p.y >= 0 && p.y < CANVAS_HEIGHT) {
                canvas[p.x][p.y] = p.color;
            }
        }
        saveCanvas();
        io.emit('batch update', imageData);
        socket.emit('chat message', { sender: '🖼️', text: 'Изображение загружено' });
    });

    socket.on('disconnect', () => {
        const player = players.get(socket.id);
        if (player) {
            players.delete(socket.id);
            io.emit('online update', getOnlineList());
            io.emit('chat message', { sender: '📢', text: `${player.nickname} вышел` });
        }
    });
});

function getOnlineList() {
    return Array.from(players.values()).map(p => p.nickname);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pixel Battle на ${PORT}`));