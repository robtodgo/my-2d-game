const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.static('public'));

// ---------- Конфигурация ----------
const MAP_WIDTH = 3000;
const MAP_HEIGHT = 3000;
const TILE_SIZE = 40;

// Карта блоков
const worldTiles = Array(Math.floor(MAP_WIDTH / TILE_SIZE)).fill().map(() =>
    Array(Math.floor(MAP_HEIGHT / TILE_SIZE)).fill(null)
);
for (let i = 0; i < 50; i++) {
    for (let j = 0; j < 30; j++) {
        if (i < worldTiles.length && j < worldTiles[0].length)
            worldTiles[i][j] = { type: 'grass' };
    }
}

// Аккаунты (в памяти)
const accounts = {}; // nickname -> { password, ... }

// Активные игроки
const players = {};

// Администраторы
const admins = new Set();
const ADMIN_PASSWORD = 'secret123';

// Предметы
function createItem(itemId, count = 1) {
    const items = {
        'sword': { name: 'Меч', emoji: '🗡️', damage: 25 },
        'pickaxe': { name: 'Кирка', emoji: '⛏️', damage: 10 },
        'apple': { name: 'Яблоко', emoji: '🍎', heal: 20 },
        'wood': { name: 'Дерево', emoji: '🪵' },
        'stone': { name: 'Камень', emoji: '🪨' }
    };
    const base = items[itemId] || { name: itemId, emoji: '📦' };
    return { id: itemId, count, ...base };
}

function getRandomSpawn() {
    return { x: 500 + Math.random() * 500, y: 500 + Math.random() * 500 };
}

// ---------- Обработка подключений ----------
io.on('connection', (socket) => {
    console.log(`Подключение: ${socket.id}`);

    // Регистрация
    socket.on('register', (data, callback) => {
        const { nickname, password, color } = data;
        if (!nickname || !password) return callback({ success: false, message: 'Логин и пароль обязательны' });
        if (accounts[nickname]) return callback({ success: false, message: 'Аккаунт уже существует' });
        accounts[nickname] = { password, color: color || '#3498db' };
        callback({ success: true });
    });

    // Вход
    socket.on('login', (data, callback) => {
        const { nickname, password } = data;
        const acc = accounts[nickname];
        if (!acc || acc.password !== password) return callback({ success: false, message: 'Неверный логин или пароль' });
        if (Object.values(players).some(p => p.nickname === nickname)) return callback({ success: false, message: 'Уже в игре' });

        const spawn = getRandomSpawn();
        players[socket.id] = {
            id: socket.id,
            nickname,
            color: acc.color,
            x: spawn.x, y: spawn.y,
            hp: 100, maxHp: 100,
            inventory: [
                createItem('sword', 1),
                createItem('pickaxe', 1),
                createItem('apple', 5),
                null, null, null, null, null, null
            ],
            selectedSlot: 0,
            lastAttack: 0
        };

        callback({ success: true, self: players[socket.id] });

        socket.emit('init', {
            self: players[socket.id],
            players,
            map: { width: MAP_WIDTH, height: MAP_HEIGHT, tileSize: TILE_SIZE },
            worldTiles
        });
        socket.broadcast.emit('player joined', players[socket.id]);
        console.log(`Игрок ${nickname} вошёл`);
    });

    socket.on('move', (data) => {
        const p = players[socket.id];
        if (!p) return;
        let { x, y } = data;
        x = Math.max(20, Math.min(MAP_WIDTH - 20, x));
        y = Math.max(20, Math.min(MAP_HEIGHT - 20, y));
        p.x = x; p.y = y;
        io.emit('player moved', { id: socket.id, x, y });
    });

    socket.on('attack', (targetId) => {
        const attacker = players[socket.id];
        const target = players[targetId];
        if (!attacker || !target) return;
        const now = Date.now();
        if (now - attacker.lastAttack < 500) return;
        const dist = Math.hypot(attacker.x - target.x, attacker.y - target.y);
        if (dist > 60) return;

        const weapon = attacker.inventory[attacker.selectedSlot];
        const damage = (weapon && weapon.damage) ? weapon.damage : 10;
        target.hp = Math.max(0, target.hp - damage);
        attacker.lastAttack = now;

        io.emit('player damaged', { id: targetId, hp: target.hp, attacker: attacker.nickname });
        if (target.hp <= 0) {
            const spawn = getRandomSpawn();
            target.x = spawn.x; target.y = spawn.y;
            target.hp = target.maxHp;
            io.emit('player respawned', { id: targetId, x: target.x, y: target.y, hp: target.hp });
            io.emit('chat message', { sender: 'System', text: `${target.nickname} был убит ${attacker.nickname}` });
        }
    });

    socket.on('use item', () => {
        const p = players[socket.id];
        if (!p) return;
        const item = p.inventory[p.selectedSlot];
        if (item?.id === 'apple' && p.hp < p.maxHp) {
            p.hp = Math.min(p.maxHp, p.hp + item.heal);
            item.count--;
            if (item.count <= 0) p.inventory[p.selectedSlot] = null;
            io.emit('inventory update', { id: socket.id, inventory: p.inventory, selectedSlot: p.selectedSlot });
            io.emit('player hp', { id: socket.id, hp: p.hp });
        }
    });

    socket.on('select slot', (slot) => {
        const p = players[socket.id];
        if (p && slot >= 0 && slot < p.inventory.length) {
            p.selectedSlot = slot;
            socket.emit('inventory update', { inventory: p.inventory, selectedSlot: slot });
        }
    });

    socket.on('break block', (data) => {
        const p = players[socket.id];
        if (!p) return;
        const { tileX, tileY } = data;
        if (tileX < 0 || tileX >= worldTiles.length || tileY < 0 || tileY >= worldTiles[0].length) return;
        const dist = Math.hypot(p.x - (tileX*TILE_SIZE + TILE_SIZE/2), p.y - (tileY*TILE_SIZE + TILE_SIZE/2));
        if (dist > 100) return;
        if (worldTiles[tileX][tileY] !== null) {
            worldTiles[tileX][tileY] = null;
            io.emit('block update', { tileX, tileY, block: null });
            // Дроп дерева
            const drop = createItem('wood', 1);
            const inv = p.inventory;
            let added = false;
            for (let i = 0; i < inv.length; i++) {
                if (inv[i] && inv[i].id === drop.id) { inv[i].count += drop.count; added = true; break; }
            }
            if (!added) {
                for (let i = 0; i < inv.length; i++) {
                    if (!inv[i]) { inv[i] = drop; added = true; break; }
                }
            }
            if (added) socket.emit('inventory update', { inventory: inv, selectedSlot: p.selectedSlot });
        }
    });

    // Чат и команды
    socket.on('chat message', (msg) => {
        const p = players[socket.id];
        if (!p) return;
        if (msg.startsWith('/')) {
            const args = msg.slice(1).split(' ');
            const cmd = args[0].toLowerCase();
            if (cmd === 'find' && args[1]) {
                const target = Object.values(players).find(pl => pl.nickname === args[1]);
                if (target) {
                    socket.emit('chat message', { sender: 'System', text: `${target.nickname} находится на (${Math.round(target.x)}, ${Math.round(target.y)})` });
                } else {
                    socket.emit('chat message', { sender: 'System', text: 'Игрок не найден' });
                }
            } else if (cmd === 'tp' && args[1]) {
                const target = Object.values(players).find(pl => pl.nickname === args[1]);
                if (target) {
                    p.x = target.x; p.y = target.y;
                    io.emit('player moved', { id: socket.id, x: p.x, y: p.y });
                    socket.emit('chat message', { sender: 'System', text: `Телепортирован к ${target.nickname}` });
                } else {
                    socket.emit('chat message', { sender: 'System', text: 'Игрок не найден' });
                }
            } else if (cmd === 'op' && args[1] === ADMIN_PASSWORD) {
                admins.add(socket.id);
                socket.emit('admin status', true);
                socket.emit('chat message', { sender: 'System', text: 'Права администратора получены' });
            } else if (admins.has(socket.id)) {
                // Админские команды
                if (cmd === 'give' && args[1] && args[2]) {
                    const target = Object.values(players).find(pl => pl.nickname === args[1]);
                    if (target) {
                        const item = createItem(args[2], parseInt(args[3]) || 1);
                        let added = false;
                        for (let i = 0; i < target.inventory.length; i++) {
                            if (target.inventory[i] && target.inventory[i].id === item.id) {
                                target.inventory[i].count += item.count; added = true; break;
                            }
                        }
                        if (!added) {
                            for (let i = 0; i < target.inventory.length; i++) {
                                if (!target.inventory[i]) { target.inventory[i] = item; added = true; break; }
                            }
                        }
                        if (added) {
                            io.to(target.id).emit('inventory update', { inventory: target.inventory, selectedSlot: target.selectedSlot });
                            socket.emit('chat message', { sender: 'Admin', text: `Выдано ${item.count}x ${item.name} игроку ${target.nickname}` });
                        }
                    }
                } else if (cmd === 'setblock' && args[1] && args[2]) {
                    const x = parseInt(args[1]), y = parseInt(args[2]), type = args[3] || 'grass';
                    if (!isNaN(x) && !isNaN(y) && x>=0 && x<worldTiles.length && y>=0 && y<worldTiles[0].length) {
                        worldTiles[x][y] = { type };
                        io.emit('block update', { tileX: x, tileY: y, block: { type } });
                    }
                }
            } else {
                socket.emit('chat message', { sender: 'System', text: 'Неизвестная команда' });
            }
        } else {
            io.emit('chat message', { sender: p.nickname, text: msg });
        }
    });

    socket.on('ping', () => socket.emit('pong'));

    socket.on('disconnect', () => {
        const p = players[socket.id];
        if (p) {
            delete players[socket.id];
            admins.delete(socket.id);
            io.emit('player left', socket.id);
            console.log(`Игрок ${p.nickname} отключился`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер на порту ${PORT}`));