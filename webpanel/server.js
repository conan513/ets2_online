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

// Start Server
app.listen(PORT, () => {
    console.log(`Server Manager Web Panel running on port ${PORT}`);
});
