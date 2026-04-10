const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));

const SIZE = 80; // 80x80 пикселей
const COLORS = ['#FFFFFF', '#000000', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF'];

// Холст
let canvas = Array(SIZE).fill().map(() => Array(SIZE).fill('#FFFFFF'));

// Загружаем сохранённый холст
try {
    if (fs.existsSync('canvas.json')) {
        canvas = JSON.parse(fs.readFileSync('canvas.json'));
    }
} catch(e) {}

// Игроки
const players = new Map(); // socket.id -> nickname
const accounts = new Map(); // nickname -> password

io.on('connection', (socket) => {
    console.log('+', socket.id);

    socket.on('register', (data, cb) => {
        const { nick, pass } = data;
        if (!nick || !pass) return cb('Заполните поля');
        if (accounts.has(nick)) return cb('Ник занят');
        accounts.set(nick, pass);
        cb(null);
    });

    socket.on('login', (data, cb) => {
        const { nick, pass } = data;
        if (!accounts.has(nick) || accounts.get(nick) !== pass) return cb('Неверный логин/пароль');
        if ([...players.values()].includes(nick)) return cb('Уже в игре');
        players.set(socket.id, nick);
        cb(null, canvas, getOnline());
        io.emit('online', getOnline());
        io.emit('chat', '📢', `${nick} зашёл`);
    });

    socket.on('draw', (data, cb) => {
        const nick = players.get(socket.id);
        if (!nick) return cb('Не авторизован');
        const { x, y, color } = data;
        if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return cb('За пределами');
        canvas[x][y] = color;
        fs.writeFileSync('canvas.json', JSON.stringify(canvas));
        io.emit('pixel', x, y, color);
        cb(null);
    });

    socket.on('chat', (msg) => {
        const nick = players.get(socket.id);
        if (!nick) return;
        io.emit('chat', nick, msg);
    });

    socket.on('disconnect', () => {
        const nick = players.get(socket.id);
        if (nick) {
            players.delete(socket.id);
            io.emit('online', getOnline());
            io.emit('chat', '📢', `${nick} вышел`);
        }
    });
});

function getOnline() {
    return [...players.values()];
}

server.listen(process.env.PORT || 3000, () => console.log('✅ Сервер запущен'));