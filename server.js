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
const DEFAULT_COOLDOWN = 5000;
const SAVE_FILE = path.join(__dirname, 'canvas.json');
const BANS_FILE = path.join(__dirname, 'bans.json');

const accounts = new Map();
const players = new Map();
const onlineIPs = new Set();
let bans = new Set();

if (fs.existsSync(BANS_FILE)) {
    try { bans = new Set(JSON.parse(fs.readFileSync(BANS_FILE, 'utf8'))); } catch(e) {}
}

let canvas;
if (fs.existsSync(SAVE_FILE)) {
    try { canvas = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')); } catch(e) { initCanvas(); }
} else { initCanvas(); }

function initCanvas() {
    canvas = Array(CANVAS_WIDTH / PIXEL_SIZE).fill().map(() =>
        Array(CANVAS_HEIGHT / PIXEL_SIZE).fill('#ffffff')
    );
}
function saveCanvas() { fs.writeFileSync(SAVE_FILE, JSON.stringify(canvas)); }
function saveBans() { fs.writeFileSync(BANS_FILE, JSON.stringify([...bans])); }

let globalCooldown = DEFAULT_COOLDOWN;
setInterval(saveCanvas, 10000);

io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;
    console.log(`+ ${socket.id} (${clientIp})`);

    if (bans.has(clientIp)) {
        socket.emit('banned');
        socket.disconnect();
        return;
    }

    socket.on('register', (data, callback) => {
        const { nickname, password } = data;
        if (!nickname || !password) return callback({ ok: false, msg: 'Заполните поля' });
        if (accounts.has(nickname)) return callback({ ok: false, msg: 'Аккаунт уже существует' });
        accounts.set(nickname, { password, ip: clientIp });
        callback({ ok: true });
    });

    socket.on('login', (data, callback) => {
        const { nickname, password } = data;
        const acc = accounts.get(nickname);
        if (!acc || acc.password !== password) return callback({ ok: false, msg: 'Неверный логин/пароль' });
        if (bans.has(acc.ip)) return callback({ ok: false, msg: 'Ваш IP забанен' });

        if (onlineIPs.has(clientIp)) {
            return callback({ ok: false, msg: 'С этого IP уже кто-то играет' });
        }

        for (const [id, p] of players.entries()) {
            if (p.nickname === nickname) {
                players.delete(id);
                onlineIPs.delete(p.ip);
                io.to(id).emit('force logout');
                io.sockets.sockets.get(id)?.disconnect();
            }
        }

        onlineIPs.add(clientIp);
        const player = {
            nickname,
            lastDraw: 0,
            ip: clientIp,
            isAdmin: false,
        };
        players.set(socket.id, player);

        callback({ ok: true, canvas, online: getOnlineList(), cooldown: globalCooldown });
        io.emit('online update', getOnlineList());
        io.emit('chat message', { sender: '📢', text: `${nickname} присоединился` });
    });

    socket.on('auto login', (nickname, callback) => {
        if (!accounts.has(nickname)) return callback({ ok: false });
        const acc = accounts.get(nickname);
        if (bans.has(acc.ip)) return callback({ ok: false });
        if (onlineIPs.has(clientIp)) return callback({ ok: false });

        for (const [id, p] of players.entries()) {
            if (p.nickname === nickname) {
                players.delete(id);
                onlineIPs.delete(p.ip);
                io.to(id).emit('force logout');
                io.sockets.sockets.get(id)?.disconnect();
            }
        }
        onlineIPs.add(clientIp);
        const player = { nickname, lastDraw: 0, ip: clientIp, isAdmin: false };
        players.set(socket.id, player);
        callback({ ok: true, canvas, online: getOnlineList(), cooldown: globalCooldown });
        io.emit('online update', getOnlineList());
        io.emit('chat message', { sender: '📢', text: `${nickname} присоединился` });
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
        const gridX = Math.floor(x / PIXEL_SIZE);
        const gridY = Math.floor(y / PIXEL_SIZE);
        if (gridX < 0 || gridX >= canvas.length || gridY < 0 || gridY >= canvas[0].length)
            return callback({ ok: false, msg: 'За пределами холста' });

        // Проверка на одинаковый цвет (не тратим попытку)
        if (canvas[gridX][gridY] === color) {
            return callback({ ok: false, msg: 'Здесь уже такой цвет' });
        }

        canvas[gridX][gridY] = color;
        player.lastDraw = now;
        saveCanvas();

        io.emit('pixel update', { x: gridX, y: gridY, color });
        callback({ ok: true });
    });

    socket.on('chat message', (msg) => {
        const player = players.get(socket.id);
        if (!player) return;
        io.emit('chat message', { sender: player.nickname, text: msg });
    });

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
                    socket.emit('chat message', { sender: '⚙️', text: `Задержка изменена на ${args[1]} сек` });
                }
            } else if (args[0] === '/ban' && args[1]) {
                const targetNick = args[1];
                const target = [...players.entries()].find(([_, p]) => p.nickname === targetNick);
                if (target) {
                    const [id, p] = target;
                    bans.add(p.ip);
                    saveBans();
                    io.to(id).emit('banned');
                    io.sockets.sockets.get(id)?.disconnect();
                    socket.emit('chat message', { sender: '🔨', text: `Игрок ${targetNick} забанен` });
                } else {
                    const acc = accounts.get(targetNick);
                    if (acc) { bans.add(acc.ip); saveBans(); socket.emit('chat message', { sender: '🔨', text: `IP игрока ${targetNick} забанен` }); }
                    else socket.emit('chat message', { sender: '❌', text: 'Игрок не найден' });
                }
            } else if (args[0] === '/unban' && args[1]) {
                const acc = accounts.get(args[1]);
                if (acc) { bans.delete(acc.ip); saveBans(); socket.emit('chat message', { sender: '🔓', text: `IP ${args[1]} разбанен` }); }
            } else if (args[0] === '/clear') {
                initCanvas(); saveCanvas();
                io.emit('canvas reset', canvas);
                socket.emit('chat message', { sender: '🧹', text: 'Холст очищен' });
            } else if (args[0] === '/kick' && args[1]) {
                const target = [...players.entries()].find(([_, p]) => p.nickname === args[1]);
                if (target) { io.to(target[0]).emit('force logout'); io.sockets.sockets.get(target[0])?.disconnect(); socket.emit('chat message', { sender: '👢', text: `${args[1]} кикнут` }); }
            }
        }
    });

    socket.on('disconnect', () => {
        const player = players.get(socket.id);
        if (player) {
            onlineIPs.delete(player.ip);
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