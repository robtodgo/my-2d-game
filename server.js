const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.static('public'));

// ---------- Конфигурация ----------
const MAP_WIDTH = 3000;
const MAP_HEIGHT = 3000;
const TILE_SIZE = 40;
const ADMIN_PASSWORD = 'secret123';
const MAX_NICKNAME = 12;

// Карта блоков
const worldTiles = Array(Math.floor(MAP_WIDTH / TILE_SIZE)).fill().map(() =>
    Array(Math.floor(MAP_HEIGHT / TILE_SIZE)).fill(null)
);
for (let i = 0; i < 50; i++) for (let j = 0; j < 30; j++) 
    if (i < worldTiles.length && j < worldTiles[0].length) worldTiles[i][j] = { type: 'grass' };

// Хранилища
const accounts = new Map(); // nickname -> { password, color, avatar, friends: Set }
const players = new Map();  // socket.id -> player object
const admins = new Set();

// Друзья (в памяти, при перезапуске сбрасываются)
const friendRequests = new Map(); // from -> to

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
function getRandomSpawn() { return { x: 500 + Math.random() * 500, y: 500 + Math.random() * 500 }; }

// ---------- Обработка подключений ----------
io.on('connection', (socket) => {
    console.log(`+ ${socket.id}`);

    // Регистрация
    socket.on('register', (data, callback) => {
        let { nickname, password, color, avatar } = data;
        nickname = nickname.trim().substring(0, MAX_NICKNAME);
        if (!nickname || !password) return callback({ success: false, message: 'Логин и пароль обязательны' });
        if (accounts.has(nickname)) return callback({ success: false, message: 'Аккаунт существует' });

        accounts.set(nickname, {
            password,
            color: color || '#3498db',
            avatar: avatar || null,
            friends: new Set()
        });
        callback({ success: true });
    });

    // Вход
    socket.on('login', (data, callback) => {
        let { nickname, password } = data;
        nickname = nickname.trim().substring(0, MAX_NICKNAME);
        const acc = accounts.get(nickname);
        if (!acc || acc.password !== password) return callback({ success: false, message: 'Неверный логин/пароль' });
        if ([...players.values()].some(p => p.nickname === nickname)) return callback({ success: false, message: 'Уже в игре' });

        const spawn = getRandomSpawn();
        const player = {
            id: socket.id,
            nickname,
            color: acc.color,
            avatar: acc.avatar,
            x: spawn.x, y: spawn.y,
            hp: 100, maxHp: 100,
            inventory: [ createItem('sword',1), createItem('pickaxe',1), createItem('apple',5), ...Array(6).fill(null) ],
            selectedSlot: 0,
            lastAttack: 0
        };
        players.set(socket.id, player);
        callback({ success: true, self: player });

        socket.emit('init', {
            self: player,
            players: Object.fromEntries(players),
            map: { width: MAP_WIDTH, height: MAP_HEIGHT, tileSize: TILE_SIZE },
            worldTiles,
            friends: [...(acc.friends || [])]
        });
        socket.broadcast.emit('player joined', player);
        console.log(`>> ${nickname}`);
    });

    // Выход из аккаунта (но сокет остаётся)
    socket.on('logout', () => {
        const p = players.get(socket.id);
        if (p) {
            players.delete(socket.id);
            admins.delete(socket.id);
            io.emit('player left', socket.id);
            console.log(`<< ${p.nickname} logout`);
        }
        socket.emit('logged out');
    });

    // Движение
    socket.on('move', (data) => {
        const p = players.get(socket.id);
        if (!p) return;
        p.x = Math.max(20, Math.min(MAP_WIDTH - 20, data.x));
        p.y = Math.max(20, Math.min(MAP_HEIGHT - 20, data.y));
        io.emit('player moved', { id: socket.id, x: p.x, y: p.y });
    });

    // Атака
    socket.on('attack', (targetId) => {
        const a = players.get(socket.id);
        const t = players.get(targetId);
        if (!a || !t || Date.now() - a.lastAttack < 500) return;
        if (Math.hypot(a.x - t.x, a.y - t.y) > 60) return;
        const dmg = a.inventory[a.selectedSlot]?.damage || 10;
        t.hp = Math.max(0, t.hp - dmg);
        a.lastAttack = Date.now();
        io.emit('player damaged', { id: targetId, hp: t.hp, attacker: a.nickname });
        if (t.hp <= 0) {
            const sp = getRandomSpawn();
            t.x = sp.x; t.y = sp.y; t.hp = t.maxHp;
            io.emit('player respawned', { id: targetId, x: t.x, y: t.y, hp: t.hp });
            io.emit('chat message', { sender: '☠️', text: `${t.nickname} убит ${a.nickname}` });
        }
    });

    // Использование предмета (яблоко)
    socket.on('use item', () => {
        const p = players.get(socket.id);
        if (!p) return;
        const item = p.inventory[p.selectedSlot];
        if (item?.id === 'apple' && p.hp < p.maxHp) {
            p.hp = Math.min(p.maxHp, p.hp + item.heal);
            if (--item.count <= 0) p.inventory[p.selectedSlot] = null;
            io.emit('inventory update', { id: socket.id, inventory: p.inventory, selectedSlot: p.selectedSlot });
            io.emit('player hp', { id: socket.id, hp: p.hp });
        }
    });

    // Выбор слота
    socket.on('select slot', (slot) => {
        const p = players.get(socket.id);
        if (p && slot >= 0 && slot < p.inventory.length) {
            p.selectedSlot = slot;
            socket.emit('inventory update', { inventory: p.inventory, selectedSlot: slot });
        }
    });

    // Разрушение блока
    socket.on('break block', (data) => {
        const p = players.get(socket.id);
        if (!p) return;
        const { tileX, tileY } = data;
        if (tileX < 0 || tileX >= worldTiles.length || tileY < 0 || tileY >= worldTiles[0].length) return;
        if (Math.hypot(p.x - (tileX*TILE_SIZE+TILE_SIZE/2), p.y - (tileY*TILE_SIZE+TILE_SIZE/2)) > 100) return;
        if (worldTiles[tileX][tileY]) {
            worldTiles[tileX][tileY] = null;
            io.emit('block update', { tileX, tileY, block: null });
            const drop = createItem('wood', 1);
            const inv = p.inventory;
            let added = false;
            for (let i = 0; i < inv.length; i++) {
                if (inv[i]?.id === drop.id) { inv[i].count += drop.count; added = true; break; }
            }
            if (!added) for (let i = 0; i < inv.length; i++) if (!inv[i]) { inv[i] = drop; added = true; break; }
            if (added) socket.emit('inventory update', { inventory: inv, selectedSlot: p.selectedSlot });
        }
    });

    // Чат и команды
    socket.on('chat message', (msg) => {
        const p = players.get(socket.id);
        if (!p) return;
        if (!msg.startsWith('/')) {
            io.emit('chat message', { sender: p.nickname, text: msg });
            return;
        }
        const args = msg.slice(1).split(' ');
        const cmd = args[0].toLowerCase();
        const acc = accounts.get(p.nickname);

        // Публичные команды
        if (cmd === 'find' || cmd === 'profile') {
            const target = [...players.values()].find(pl => pl.nickname === args[1]);
            if (target) socket.emit('chat message', { sender: '📋', text: `${target.nickname}: ❤️${target.hp}/${target.maxHp} 📍${Math.round(target.x)},${Math.round(target.y)}` });
            else socket.emit('chat message', { sender: '❌', text: 'Игрок не в сети' });
        } else if (cmd === 'tp' && args[1]) {
            const target = [...players.values()].find(pl => pl.nickname === args[1]);
            if (target) { p.x = target.x; p.y = target.y; io.emit('player moved', { id: socket.id, x: p.x, y: p.y }); socket.emit('chat message', { sender: '✨', text: `Телепорт к ${target.nickname}` }); }
            else socket.emit('chat message', { sender: '❌', text: 'Игрок не в сети' });
        } else if (cmd === 'help') {
            socket.emit('chat message', { sender: '📚', text: '/find <ник>, /profile, /tp <ник>, /friend add <ник>, /friend accept <ник>, /friend list, /op <пароль>' });
        } else if (cmd === 'friend') {
            if (args[1] === 'add' && args[2]) {
                const target = args[2];
                if (!accounts.has(target)) return socket.emit('chat message', { sender: '❌', text: 'Игрок не найден' });
                if (acc.friends.has(target)) return socket.emit('chat message', { sender: '❌', text: 'Уже в друзьях' });
                friendRequests.set(p.nickname + '->' + target, { from: p.nickname, to: target });
                socket.emit('chat message', { sender: '📨', text: `Заявка отправлена ${target}` });
                const targetSocket = [...players.entries()].find(([_, pl]) => pl.nickname === target)?.[0];
                if (targetSocket) io.to(targetSocket).emit('friend request', { from: p.nickname });
            } else if (args[1] === 'accept' && args[2]) {
                const from = args[2];
                if (friendRequests.has(from + '->' + p.nickname)) {
                    friendRequests.delete(from + '->' + p.nickname);
                    acc.friends.add(from);
                    accounts.get(from).friends.add(p.nickname);
                    socket.emit('chat message', { sender: '✅', text: `Теперь вы друзья с ${from}` });
                    const fromSocket = [...players.entries()].find(([_, pl]) => pl.nickname === from)?.[0];
                    if (fromSocket) io.to(fromSocket).emit('friend accepted', { by: p.nickname });
                    // Обновить список друзей у обоих
                    socket.emit('friends update', [...acc.friends]);
                    if (fromSocket) io.to(fromSocket).emit('friends update', [...accounts.get(from).friends]);
                } else socket.emit('chat message', { sender: '❌', text: 'Нет такой заявки' });
            } else if (args[1] === 'list') {
                socket.emit('chat message', { sender: '👥', text: `Друзья: ${[...acc.friends].join(', ') || 'нет'}` });
            }
        } else if (cmd === 'op' && args[1] === ADMIN_PASSWORD) {
            admins.add(socket.id);
            socket.emit('admin status', true);
            socket.emit('chat message', { sender: '🔓', text: 'Права администратора' });
        } else if (admins.has(socket.id)) {
            if (cmd === 'give' && args[1] && args[2]) {
                const target = [...players.values()].find(pl => pl.nickname === args[1]);
                if (target) {
                    const item = createItem(args[2], parseInt(args[3]) || 1);
                    let added = false;
                    for (let i = 0; i < target.inventory.length; i++) {
                        if (target.inventory[i]?.id === item.id) { target.inventory[i].count += item.count; added = true; break; }
                    }
                    if (!added) for (let i = 0; i < target.inventory.length; i++) if (!target.inventory[i]) { target.inventory[i] = item; added = true; break; }
                    if (added) {
                        io.to(target.id).emit('inventory update', { inventory: target.inventory, selectedSlot: target.selectedSlot });
                        socket.emit('chat message', { sender: '🎁', text: `${item.count}x ${item.name} → ${target.nickname}` });
                    }
                }
            } else if (cmd === 'setblock' && args[1] && args[2]) {
                const x = parseInt(args[1]), y = parseInt(args[2]);
                if (!isNaN(x) && !isNaN(y) && x>=0 && x<worldTiles.length && y>=0 && y<worldTiles[0].length) {
                    worldTiles[x][y] = { type: args[3] || 'grass' };
                    io.emit('block update', { tileX: x, tileY: y, block: worldTiles[x][y] });
                }
            }
        } else socket.emit('chat message', { sender: '❓', text: 'Неизвестная команда. /help' });
    });

    socket.on('ping', () => socket.emit('pong'));

    socket.on('disconnect', () => {
        const p = players.get(socket.id);
        if (p) {
            players.delete(socket.id);
            admins.delete(socket.id);
            io.emit('player left', socket.id);
            console.log(`-- ${p.nickname}`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер на ${PORT}`));