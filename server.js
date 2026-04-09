const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.static('public'));

// Хранилище игроков и стена
const players = new Map();
const wall = {
    holds: [
        { id: 'hold1', x: 300, y: 500, type: 'normal' },
        { id: 'hold2', x: 400, y: 300, type: 'good' },
        { id: 'hold3', x: 200, y: 150, type: 'bad' },
        { id: 'hold4', x: 600, y: 400, type: 'good' },
        { id: 'hold5', x: 700, y: 200, type: 'normal' },
        { id: 'hold6', x: 500, y: 550, type: 'bad' },
    ]
};

io.on('connection', (socket) => {
    console.log(`Новый игрок подключился: ${socket.id}`);

    // Обработка входа игрока
    socket.on('join', (data, callback) => {
        const nickname = data.nickname.trim().substring(0, 12) || 'Аноним';
        const color = data.color || '#e74c3c';
        
        // Начальная позиция: левая рука на первом зацепе, правая на втором
        const player = {
            id: socket.id,
            nickname: nickname,
            color: color,
            leftHand: { holdId: 'hold1' }, // Левая рука на hold1
            rightHand: { holdId: 'hold2' }, // Правая рука на hold2
            stamina: 100,
            maxStamina: 100,
            fall: false,
        };
        
        players.set(socket.id, player);
        
        // Отправляем новому игроку информацию о стене и других игроках
        callback({
            success: true,
            wall: wall,
            players: Array.from(players.values())
        });
        
        // Оповещаем остальных о новом игроке
        socket.broadcast.emit('playerJoined', player);
    });

    // Обработка движения руки
    socket.on('grab', (data) => {
        const player = players.get(socket.id);
        if (!player || player.fall) return;

        const targetHold = wall.holds.find(h => h.id === data.holdId);
        if (!targetHold) return;

        // Проверка, не занят ли зацеп другой рукой этого же игрока
        const otherHandHold = (data.hand === 'left') ? player.rightHand?.holdId : player.leftHand?.holdId;
        if (otherHandHold === targetHold.id) {
            socket.emit('grabFailed', { reason: 'Зацеп уже занят другой рукой' });
            return;
        }

        // Проверка дистанции до зацепа (упрощённая)
        const handPos = (data.hand === 'left') ? player.leftHand : player.rightHand;
        const currentHold = handPos ? wall.holds.find(h => h.id === handPos.holdId) : null;
        if (currentHold) {
            const dist = Math.hypot(targetHold.x - currentHold.x, targetHold.y - currentHold.y);
            if (dist > 250) {
                socket.emit('grabFailed', { reason: 'Слишком далеко' });
                return;
            }
        }

        // Расход выносливости
        const staminaCost = (targetHold.type === 'good') ? 10 : (targetHold.type === 'bad') ? 30 : 20;
        if (player.stamina < staminaCost) {
            socket.emit('grabFailed', { reason: 'Недостаточно выносливости' });
            return;
        }

        // Перемещаем руку
        if (data.hand === 'left') {
            player.leftHand = { holdId: targetHold.id };
        } else {
            player.rightHand = { holdId: targetHold.id };
        }
        player.stamina -= staminaCost;

        // Проверка на падение (обе руки в воздухе)
        if (!player.leftHand && !player.rightHand) {
            player.fall = true;
            io.emit('playerFell', player.id);
        }

        // Отправляем обновление всем игрокам
        io.emit('playerMoved', player);
    });

    // Восстановление выносливости (если не двигается)
    socket.on('rest', () => {
        const player = players.get(socket.id);
        if (player && !player.fall) {
            player.stamina = Math.min(player.maxStamina, player.stamina + 5);
            io.emit('playerMoved', player);
        }
    });

    // Отключение игрока
    socket.on('disconnect', () => {
        console.log(`Игрок отключился: ${socket.id}`);
        const player = players.get(socket.id);
        if (player) {
            players.delete(socket.id);
            io.emit('playerLeft', socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер скалолазания запущен на порту ${PORT}`));