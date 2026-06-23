const express = require('express');
const multer = require('multer');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8081;

// Paths
const STEAM_HOME = path.resolve(__dirname, '..');
const GAMES = {
    ets2: {
        service: 'ets2server.service',
        dirName: 'Euro Truck Simulator 2',
        dataDir: path.join(STEAM_HOME, 'ets2-data/Euro Truck Simulator 2'),
        binary: path.join(STEAM_HOME, 'ets2-server/bin/linux_x64/eurotrucks2_server'),
        launchDir: path.join(STEAM_HOME, 'ets2-data')
    },
    ats: {
        service: 'atsserver.service',
        dirName: 'American Truck Simulator',
        dataDir: path.join(STEAM_HOME, 'ats-data/American Truck Simulator'),
        binary: path.join(STEAM_HOME, 'ats-server/bin/linux_x64/amtrucks_server'),
        launchDir: path.join(STEAM_HOME, 'ats-data')
    }
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer for file uploads
const upload = multer({ dest: '/tmp/' });

// CPU calculation helper (non-blocking diff)
let lastCpuStats = null;
function readCpuStats() {
    try {
        const data = fs.readFileSync('/proc/stat', 'utf8');
        const firstLine = data.split('\n')[0];
        const parts = firstLine.split(/\s+/).slice(1).map(Number);
        const idle = parts[3] + parts[4]; // idle + iowait
        const total = parts.reduce((a, b) => a + b, 0);
        return { idle, total };
    } catch (e) {
        return { idle: 0, total: 0 };
    }
}

function getCpuPercent() {
    const current = readCpuStats();
    if (!lastCpuStats) {
        lastCpuStats = current;
        return 0;
    }
    const idleDiff = current.idle - lastCpuStats.idle;
    const totalDiff = current.total - lastCpuStats.total;
    lastCpuStats = current;
    if (totalDiff === 0) return 0;
    return Math.round((1 - idleDiff / totalDiff) * 100);
}

// Memory calculation helper
function getMemPercent() {
    try {
        const data = fs.readFileSync('/proc/meminfo', 'utf8');
        const memTotalMatch = data.match(/^MemTotal:\s+(\d+)\s+kB/m);
        const memAvailableMatch = data.match(/^MemAvailable:\s+(\d+)\s+kB/m);
        if (memTotalMatch && memAvailableMatch) {
            const total = parseInt(memTotalMatch[1], 10);
            const available = parseInt(memAvailableMatch[1], 10);
            const used = total - available;
            return Math.round((used / total) * 100);
        }
    } catch (e) {}
    return 0;
}

// Check if systemd service is active
function isServiceActive(serviceName) {
    try {
        execSync(`systemctl is-active ${serviceName}`);
        return 'running';
    } catch (e) {
        return 'stopped';
    }
}

// GET /api/status
app.get('/api/status', (req, res) => {
    res.json({
        cpu: getCpuPercent(),
        ram: getMemPercent(),
        servers: {
            ets2: isServiceActive(GAMES.ets2.service),
            ats: isServiceActive(GAMES.ats.service)
        }
    });
});

// POST /api/control
app.post('/api/control', (req, res) => {
    const { game, action } = req.body;
    if (!GAMES[game] || !['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({ error: 'Hibás játék vagy parancs' });
    }

    const { service } = GAMES[game];
    
    // Check if we need to auto-generate config files for "start" if they don't exist
    if (action === 'start') {
        const configPath = path.join(GAMES[game].dataDir, 'server_config.sii');
        if (!fs.existsSync(configPath)) {
            // Generate it by running the binary briefly
            try {
                fs.mkdirSync(GAMES[game].dataDir, { recursive: true });
                const bin = GAMES[game].binary;
                if (fs.existsSync(bin)) {
                    exec(`LD_LIBRARY_PATH="${STEAM_HOME}/steamcmd/linux64" "${bin}" -homedir "${GAMES[game].launchDir}"`, { timeout: 4000 }, () => {});
                    // Wait briefly for files to sync
                    execSync('sleep 3');
                }
            } catch (e) {
                console.error("Config gen failed: ", e);
            }
        }
    }

    // Run systemctl command via passwordless sudo
    exec(`sudo systemctl ${action} ${service}`, (err, stdout, stderr) => {
        if (err) {
            console.error(`Control command failed: ${stderr}`);
            return res.status(500).json({ error: `Hiba történt a szerver ${action} parancs futtatásakor: ${stderr || err.message}` });
        }
        res.json({ success: true });
    });
});

// GET /api/logs/:game
app.get('/api/logs/:game', (req, res) => {
    const { game } = req.params;
    if (!GAMES[game]) return res.status(400).json({ error: 'Ismeretlen játék' });

    const { service } = GAMES[game];
    // Retrieve last 100 log lines from systemd journal
    exec(`journalctl -u ${service} -n 100 --no-pager`, (err, stdout, stderr) => {
        if (err) {
            return res.status(500).json({ error: 'Nem sikerült kiolvasni a naplófájlokat.' });
        }
        res.json({ logs: stdout });
    });
});

// Helper: parse simple key-values from SII config file
function parseSiiConfig(filepath) {
    if (!fs.existsSync(filepath)) return null;
    const content = fs.readFileSync(filepath, 'utf8');
    const lines = content.split('\n');
    const config = {};
    
    lines.forEach(line => {
        const match = line.match(/^\s*([a-zA-Z0-9_]+)\s*:\s*(.*)$/);
        if (match) {
            const key = match[1];
            let val = match[2].trim();
            // If it's a string, strip quotes and unescape
            if (val.startsWith('"') && val.endsWith('"')) {
                val = val.substring(1, val.length - 1).replace(/\\"/g, '"');
            } else {
                // Try parsing number
                const num = Number(val);
                if (!isNaN(num)) val = num;
            }
            config[key] = val;
        }
    });
    return config;
}

// Helper: update configuration keys in SII file content
function updateSiiConfig(filepath, updates) {
    if (!fs.existsSync(filepath)) return false;
    let content = fs.readFileSync(filepath, 'utf8');
    let lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(\s*)([a-zA-Z0-9_]+)(\s*:\s*)(.*)$/);
        if (match) {
            const indent = match[1];
            const key = match[2];
            const colon = match[3];
            
            if (updates.hasOwnProperty(key)) {
                let newVal = updates[key];
                if (typeof newVal === 'string') {
                    // String types need to be escaped and quoted
                    lines[i] = `${indent}${key}${colon}"${newVal.replace(/"/g, '\\"')}"`;
                } else {
                    lines[i] = `${indent}${key}${colon}${newVal}`;
                }
            }
        }
    }
    fs.writeFileSync(filepath, lines.join('\n'), 'utf8');
    return true;
}

// GET /api/config/:game
app.get('/api/config/:game', (req, res) => {
    const { game } = req.params;
    if (!GAMES[game]) return res.status(400).json({ error: 'Ismeretlen játék' });

    const filepath = path.join(GAMES[game].dataDir, 'server_config.sii');
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'A konfigurációs fájl még nem létezik. Kérlek indítsd el a szervert legalább egyszer.' });
    }

    const parsed = parseSiiConfig(filepath);
    const raw = fs.readFileSync(filepath, 'utf8');

    if (parsed) {
        parsed.__files = {
            dat: fs.existsSync(path.join(GAMES[game].dataDir, 'server_packages.dat')),
            sii: fs.existsSync(path.join(GAMES[game].dataDir, 'server_packages.sii'))
        };
    }

    res.json({ parsed, raw });
});

// POST /api/config/:game
app.post('/api/config/:game', (req, res) => {
    const { game } = req.params;
    const { mode, data } = req.body; // mode: 'form' or 'raw'
    
    if (!GAMES[game]) return res.status(400).json({ error: 'Ismeretlen játék' });

    const filepath = path.join(GAMES[game].dataDir, 'server_config.sii');
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'A konfigurációs fájl nem található.' });
    }

    try {
        if (mode === 'raw') {
            fs.writeFileSync(filepath, data, 'utf8');
        } else if (mode === 'form') {
            updateSiiConfig(filepath, data);
        } else {
            return res.status(400).json({ error: 'Érvénytelen mód' });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Nem sikerült elmenteni a konfigurációt: ' + err.message });
    }
});

// POST /api/upload/:game
app.post('/api/upload/:game', upload.single('file'), (req, res) => {
    const { game } = req.params;
    if (!GAMES[game]) return res.status(400).json({ error: 'Ismeretlen játék' });
    if (!req.file) return res.status(400).json({ error: 'Nem lett fájl feltöltve.' });

    const targetDir = GAMES[game].dataDir;
    fs.mkdirSync(targetDir, { recursive: true });

    const tempPath = req.file.path;
    const originalName = req.file.originalname;

    try {
        if (originalName.endsWith('.zip')) {
            // Extract zip
            exec(`unzip -o -j "${tempPath}" "server_packages.dat" "server_packages.sii" -d "${targetDir}"`, (err, stdout, stderr) => {
                // Delete temp file
                fs.unlinkSync(tempPath);
                
                if (err) {
                    console.error(stderr);
                    return res.status(500).json({ error: 'Nem sikerült kicsomagolni a zip fájlt. Biztos, hogy tartalmazza a server_packages.dat és server_packages.sii fájlokat?' });
                }
                res.json({ success: true, message: 'A zip csomag sikeresen importálva!' });
            });
        } else if (originalName === 'server_packages.dat' || originalName === 'server_packages.sii') {
            const destPath = path.join(targetDir, originalName);
            fs.copyFileSync(tempPath, destPath);
            fs.unlinkSync(tempPath);
            res.json({ success: true, message: `${originalName} sikeresen feltöltve!` });
        } else {
            fs.unlinkSync(tempPath);
            res.status(400).json({ error: 'Csak server_packages.dat, server_packages.sii, vagy ezeket tartalmazó .zip archívum tölthető fel!' });
        }
    } catch (e) {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        res.status(500).json({ error: 'Feltöltési hiba: ' + e.message });
    }
});

// ============================================================
// WORKSHOP MOD MANAGEMENT
// ============================================================

const STEAMCMD_BIN = path.join(STEAM_HOME, 'steamcmd', 'steamcmd.sh');
const CONFIG_FILE  = path.join(STEAM_HOME, 'webpanel-config.json');

const GAME_APP_IDS = { ets2: '227300', ats: '270880' };

// Load or initialize persistent config (Steam credentials etc.)
function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e) {}
    }
    return { steamUser: '', steamPass: '' };
}
function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// Where downloaded workshop mods land for each game
function workshopDir(game) {
    return path.join(STEAM_HOME, 'steamcmd', 'steamapps', 'workshop', 'content', GAME_APP_IDS[game]);
}

// List local mods for a game
function listLocalMods(game) {
    const dir = workshopDir(game);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => fs.statSync(path.join(dir, f)).isDirectory())
        .map(id => {
            const modDir = path.join(dir, id);
            // Try to read manifest for name
            let name = null;
            const siiFiles = fs.readdirSync(modDir).filter(f => f.endsWith('.sii'));
            if (siiFiles.length > 0) {
                try {
                    const content = fs.readFileSync(path.join(modDir, siiFiles[0]), 'utf8');
                    const m = content.match(/display_name\s*:\s*"([^"]+)"/);
                    if (m) name = m[1];
                } catch(e) {}
            }
            const stat = fs.statSync(modDir);
            return { id, name: name || `Mod #${id}`, downloadedAt: stat.mtime };
        });
}

// GET /api/workshop/config  – return saved Steam credentials (masked)
app.get('/api/workshop/config', (req, res) => {
    const cfg = loadConfig();
    res.json({ steamUser: cfg.steamUser, hasPass: !!cfg.steamPass });
});

// POST /api/workshop/config  – save Steam credentials
app.post('/api/workshop/config', (req, res) => {
    const { steamUser, steamPass } = req.body;
    const cfg = loadConfig();
    if (steamUser !== undefined) cfg.steamUser = steamUser;
    if (steamPass !== undefined) cfg.steamPass = steamPass;
    saveConfig(cfg);
    res.json({ success: true });
});

// GET /api/workshop/search?game=ets2&q=searchterm&cursor=*
// Uses Steam Web API (no key needed for basic queries)
app.get('/api/workshop/search', async (req, res) => {
    const { game, q = '', cursor = '*', num = '12' } = req.query;
    const appid = GAME_APP_IDS[game];
    if (!appid) return res.status(400).json({ error: 'Érvénytelen játék.' });

    const params = new URLSearchParams({
        query_type: '1',          // ranked by relevance
        numperpage: num,
        appid,
        creator_appid: appid,
        search_text: q,
        return_metadata: '1',
        return_previews: '1',
        cursor,
        key: 'STEAM_API_KEY_PLACEHOLDER'  // works without key for public items
    });

    const url = `https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/?${params}`;
    try {
        const https = require('https');
        const data = await new Promise((resolve, reject) => {
            https.get(url, r => {
                let body = '';
                r.on('data', chunk => body += chunk);
                r.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
            }).on('error', reject);
        });

        const files = (data.response && data.response.publishedfiledetails) || [];
        const items = files.map(f => ({
            id:          f.publishedfileid,
            title:       f.title || `Mod #${f.publishedfileid}`,
            description: (f.short_description || f.description || '').substring(0, 120),
            preview:     f.preview_url || '',
            tags:        (f.tags || []).map(t => t.tag),
            downloads:   f.subscriptions || 0,
            updated:     f.time_updated ? new Date(f.time_updated * 1000).toLocaleDateString('hu-HU') : ''
        }));
        res.json({ items, next_cursor: data.response ? data.response.next_cursor : null });
    } catch(e) {
        res.status(500).json({ error: 'Workshop keresési hiba: ' + e.message });
    }
});

// GET /api/workshop/mods/:game  – list locally downloaded mods
app.get('/api/workshop/mods/:game', (req, res) => {
    const { game } = req.params;
    if (!GAME_APP_IDS[game]) return res.status(400).json({ error: 'Érvénytelen játék.' });
    res.json({ mods: listLocalMods(game) });
});

// POST /api/workshop/download  – download a mod via SteamCMD
// Body: { game: 'ets2', workshopId: '123456789' }
app.post('/api/workshop/download', (req, res) => {
    const { game, workshopId } = req.body;
    const appid = GAME_APP_IDS[game];
    if (!appid || !workshopId) return res.status(400).json({ error: 'Hiányzó paraméterek.' });
    if (!fs.existsSync(STEAMCMD_BIN)) return res.status(500).json({ error: 'SteamCMD nem található. Futtasd az install.sh-t.' });

    const cfg = loadConfig();
    if (!cfg.steamUser || !cfg.steamPass) {
        return res.status(400).json({ error: 'Nincs beállítva Steam fiók. Állítsd be a Workshop beállításokban.' });
    }

    // Build SteamCMD command
    const cmd = [
        STEAMCMD_BIN,
        `+login "${cfg.steamUser}" "${cfg.steamPass}"`,
        `+workshop_download_item ${appid} ${workshopId}`,
        '+quit'
    ].join(' ');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(JSON.stringify({ status: 'started', message: 'Letöltés elindítva...' }) + '\n');

    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
        const output = stdout + stderr;
        if (err || output.includes('ERROR') || output.includes('FAILED')) {
            res.end(JSON.stringify({
                status: 'error',
                error: 'Letöltés sikertelen. Ellenőrizd a Steam bejelentkezési adatokat és hogy az account tulajdonosa a játéknak.',
                output: output.substring(0, 500)
            }));
        } else {
            res.end(JSON.stringify({ status: 'success', message: `Mod #${workshopId} sikeresen letöltve!` }));
        }
    });
});

// DELETE /api/workshop/mods/:game/:modId  – remove a locally downloaded mod
app.delete('/api/workshop/mods/:game/:modId', (req, res) => {
    const { game, modId } = req.params;
    const appid = GAME_APP_IDS[game];
    if (!appid) return res.status(400).json({ error: 'Érvénytelen játék.' });

    const modPath = path.join(workshopDir(game), modId);
    if (!fs.existsSync(modPath)) return res.status(404).json({ error: 'Mod nem található.' });

    exec(`rm -rf "${modPath}"`, (err) => {
        if (err) return res.status(500).json({ error: 'Törlési hiba: ' + err.message });
        res.json({ success: true });
    });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server Manager Web Panel running on port ${PORT}`);
});
