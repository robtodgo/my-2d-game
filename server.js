const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));

const players = {};
const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;

function isNicknameTaken(nickname) {
    return Object.values(players).some(p => p.nickname === nickname);
}

function getRandomSpawn() {
    return {
        x: Math.random() * (MAP_WIDTH - 40) + 20,
        y: Math.random() * (MAP_HEIGHT - 40) + 20
    };
}

io.on('connection', (socket) => {
    console.log(`Новое подключение: ${socket.id}`);

    socket.on('set nickname', (nickname, callback) => {
        if (isNicknameTaken(nickname)) {
            callback({ success: false, message: 'Ник уже занят' });
            return;
        }

        const spawn = getRandomSpawn();
        players[socket.id] = {
            id: socket.id,
            nickname: nickname,
            x: spawn.x,
            y: spawn.y
        };

        callback({ success: true });

        socket.emit('init', {
            self: players[socket.id],
            players: players,
            map: { width: MAP_WIDTH, height: MAP_HEIGHT }
        });

        socket.broadcast.emit('player joined', players[socket.id]);
        console.log(`Игрок ${nickname} вошёл`);
    });

    socket.on('move', (data) => {
        const player = players[socket.id];
        if (!player) return;

        let newX = data.x;
        let newY = data.y;

        // Границы карты
        newX = Math.max(20, Math.min(MAP_WIDTH - 20, newX));
        newY = Math.max(20, Math.min(MAP_HEIGHT - 20, newY));

        player.x = newX;
        player.y = newY;

        // Отправляем обновление позиции ВСЕМ игрокам (включая отправителя)
        io.emit('player moved', {
            id: socket.id,
            x: player.x,
            y: player.y
        });
    });

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
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});