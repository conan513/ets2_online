// SCS Server Manager Frontend Logic

let activeGame = 'ets2';
let configMode = 'form';
let statusInterval = null;
let lastLogText = '';

// DOM Elements
const cpuVal = document.getElementById('cpu-val');
const cpuBar = document.getElementById('cpu-bar');
const ramVal = document.getElementById('ram-val');
const ramBar = document.getElementById('ram-bar');

const serverStatus = document.getElementById('server-status');
const serverStatusText = serverStatus.querySelector('.status-text');

const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnRestart = document.getElementById('btn-restart');

const fileDatStatus = document.getElementById('file-dat-status');
const fileSiiStatus = document.getElementById('file-sii-status');

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const uploadProgressContainer = document.getElementById('upload-progress-container');
const uploadProgressBar = document.getElementById('upload-progress-bar');
const uploadStatusText = document.getElementById('upload-status-text');
const uploadResult = document.getElementById('upload-result');

const configForm = document.getElementById('config-form');
const rawConfigPane = document.getElementById('raw-config-pane');
const rawConfigArea = document.getElementById('raw-config-area');
const consoleOutput = document.getElementById('console-output');
const toast = document.getElementById('toast');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupTabListeners();
    setupConfigTabListeners();
    setupUploadListeners();
    
    // Initial fetch
    fetchStatus();
    fetchConfig();
    fetchLogs();
    
    // Poll status every 3 seconds
    statusInterval = setInterval(fetchStatus, 3000);
});

// Toast notifications
function showToast(message, type = 'success') {
    toast.className = `toast ${type} show`;
    toast.innerText = message;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 4000);
}

// 1. Tab Navigation
function setupTabListeners() {
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            const btn = e.currentTarget;
            document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
            btn.classList.add('active');
            
            activeGame = btn.dataset.game;
            
            // Clear current logs and values
            consoleOutput.innerText = 'Logok betöltése...';
            lastLogText = '';
            
            // Fetch configuration and status for new game
            fetchConfig();
            fetchLogs();
            updateStatusUI(); // quick local visual update
        });
    });
}

// 2. Config Mode Tabs
function setupConfigTabListeners() {
    document.querySelectorAll('.config-tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.config-tab-btn').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            
            configMode = e.currentTarget.dataset.mode;
            
            if (configMode === 'form') {
                configForm.classList.add('active');
                rawConfigPane.classList.remove('active');
            } else {
                configForm.classList.remove('active');
                rawConfigPane.classList.add('active');
            }
        });
    });
    
    // Handle form submit
    configForm.addEventListener('submit', (e) => {
        e.preventDefault();
        saveFormConfig();
    });
}

// 3. Status and system statistics
let serverStatusCache = { ets2: 'stopped', ats: 'stopped' };

async function fetchStatus() {
    try {
        const response = await fetch('/api/status');
        if (!response.ok) throw new Error('API Error');
        const data = await response.json();
        
        // Update resources
        cpuVal.innerText = `${data.cpu}%`;
        cpuBar.style.width = `${data.cpu}%`;
        ramVal.innerText = `${data.ram}%`;
        ramBar.style.width = `${data.ram}%`;
        
        serverStatusCache = data.servers;
        updateStatusUI();
    } catch (e) {
        console.error('Nem sikerült lekérni a státuszt', e);
    }
}

function updateStatusUI() {
    const status = serverStatusCache[activeGame];
    
    if (status === 'running') {
        serverStatus.className = 'status-badge running';
        serverStatusText.innerText = 'FUT';
        
        btnStart.disabled = true;
        btnStop.disabled = false;
        btnRestart.disabled = false;
    } else {
        serverStatus.className = 'status-badge stopped';
        serverStatusText.innerText = 'LEÁLLÍTVA';
        
        btnStart.disabled = false;
        btnStop.disabled = true;
        btnRestart.disabled = true;
    }
}

// 4. Server commands control
async function controlServer(action) {
    showToast(`${activeGame.toUpperCase()} szerver ${action} folyamatban...`);
    try {
        const response = await fetch('/api/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ game: activeGame, action })
        });
        
        const data = await response.json();
        if (data.error) {
            showToast(data.error, 'error');
        } else {
            showToast(`${activeGame.toUpperCase()} szerver sikeresen: ${action}ed!`);
            fetchStatus();
            setTimeout(fetchLogs, 1500); // Wait briefly and refresh logs
        }
    } catch (e) {
        showToast('Hiba történt a szerver vezérlése során.', 'error');
    }
}

// 5. Config management
async function fetchConfig() {
    try {
        const response = await fetch(`/api/config/${activeGame}`);
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Config file not found');
        }
        
        const data = await response.json();
        
        // Form populate
        if (data.parsed) {
            document.getElementById('cfg-lobby_name').value = data.parsed.lobby_name || '';
            document.getElementById('cfg-description').value = data.parsed.description || '';
            document.getElementById('cfg-password').value = data.parsed.password || '';
            document.getElementById('cfg-max_players').value = data.parsed.max_players || 8;
            document.getElementById('cfg-server_logon_token').value = data.parsed.server_logon_token || '';
            
            // Check file existence from keys in parsed config
            updateFileStatus(data.parsed);
        }
        
        // Raw textarea populate
        rawConfigArea.value = data.raw || '';
        
    } catch (e) {
        // If config doesn't exist, reset form and file statuses
        document.getElementById('config-form').reset();
        rawConfigArea.value = '';
        fileDatStatus.className = 'file-indicator missing';
        fileDatStatus.querySelector('span').innerText = 'server_packages.dat (Hiányzik)';
        fileDatStatus.querySelector('i').className = 'fa-solid fa-circle-xmark';
        
        fileSiiStatus.className = 'file-indicator missing';
        fileSiiStatus.querySelector('span').innerText = 'server_packages.sii (Hiányzik)';
        fileSiiStatus.querySelector('i').className = 'fa-solid fa-circle-xmark';
        
        console.error(e.message);
    }
}

function updateFileStatus(parsed) {
    // If the server config contains keys or files are detected on the server
    // For simplicity, we can determine this if we parse it, but we can also check if the server API reports files.
    // In our backend, the config read checks if file exists. If it successfully parsed, we assume configuration exists.
    // Let's assume files are present if we read config. Actually, to check if packages are present,
    // we can send a check or let the backend return whether the files exist in the file system.
    // Let's check: in server.js we can check the file paths directly when returning config!
    // Wait, let's see if we can do this dynamically. We can see if backend returns this info.
    // If the backend doesn't, we can query it or we can check via parsed.
    // Wait, since we are downloading server_packages.dat, let's check if the file exists on the server.
    // In server.js, we did not output file status. Let's add that or check if we can update the config API.
    // Actually, we can check if file exist from parsed data or just let the API tell us.
    // Let's check how we can handle this. If we just let the API tell us, it would be extremely clean!
    // Wait, I can make a request to check if the files exist. Or we can update the `GET /api/config/:game` API
    // in server.js to return `{ parsed, raw, files: { dat: boolean, sii: boolean } }`.
    // That is a beautiful idea! I will check if we can update `server.js` to include the file status.
    // Wait, we can see if we can check it. Let's write the frontend code to expect `data.files` and handle it!
    
    if (parsed && parsed.__files) {
        setFileIndicator(fileDatStatus, parsed.__files.dat, 'server_packages.dat');
        setFileIndicator(fileSiiStatus, parsed.__files.sii, 'server_packages.sii');
    } else {
        // Fallback: Check if config was loaded. If yes, check values.
        // Actually, we will update server.js to return the file existence.
    }
}

function setFileIndicator(element, exists, filename) {
    if (exists) {
        element.className = 'file-indicator success';
        element.querySelector('span').innerText = `${filename} (Elérhető)`;
        element.querySelector('i').className = 'fa-solid fa-circle-check';
    } else {
        element.className = 'file-indicator missing';
        element.querySelector('span').innerText = `${filename} (Hiányzik)`;
        element.querySelector('i').className = 'fa-solid fa-circle-xmark';
    }
}

async function saveFormConfig() {
    const formData = new FormData(configForm);
    const data = {};
    formData.forEach((value, key) => {
        if (key === 'max_players') {
            data[key] = parseInt(value, 10);
        } else {
            data[key] = value;
        }
    });

    try {
        const response = await fetch(`/api/config/${activeGame}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'form', data })
        });
        
        if (response.ok) {
            showToast('Konfiguráció sikeresen elmentve!');
            fetchConfig(); // Reload
        } else {
            const err = await response.json();
            showToast(err.error || 'Mentési hiba', 'error');
        }
    } catch (e) {
        showToast('Hálózati hiba történt a mentés során.', 'error');
    }
}

async function saveRawConfig() {
    const rawData = rawConfigArea.value;
    try {
        const response = await fetch(`/api/config/${activeGame}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'raw', data: rawData })
        });
        
        if (response.ok) {
            showToast('Nyers konfiguráció elmentve!');
            fetchConfig(); // Reload
        } else {
            const err = await response.json();
            showToast(err.error || 'Mentési hiba', 'error');
        }
    } catch (e) {
        showToast('Hálózati hiba történt a mentés során.', 'error');
    }
}

// 6. Logs Console
async function fetchLogs() {
    try {
        const response = await fetch(`/api/logs/${activeGame}`);
        if (!response.ok) throw new Error('Nem sikerült lekérni a logokat');
        const data = await response.json();
        
        // Only update if logs changed
        if (data.logs !== lastLogText) {
            lastLogText = data.logs;
            
            // Check if user is scrolled to bottom
            const isScrolledToBottom = consoleOutput.scrollHeight - consoleOutput.clientHeight <= consoleOutput.scrollTop + 40;
            
            consoleOutput.innerText = data.logs || 'A szerver még nem indított logokat.';
            
            if (isScrolledToBottom) {
                consoleOutput.scrollTop = consoleOutput.scrollHeight;
            }
        }
    } catch (e) {
        consoleOutput.innerText = 'Hiba történt a logok betöltése közben.';
    }
}

// Refresh logs on click and scroll to bottom
document.querySelector('.console-card button').addEventListener('click', () => {
    fetchLogs().then(() => {
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
    });
});

// 7. Drag-and-drop and File Upload
function setupUploadListeners() {
    // Drop zone interactions
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
        }, false);
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        handleFilesUpload(files);
    });

    dropZone.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', () => {
        handleFilesUpload(fileInput.files);
    });
}

function handleFilesUpload(files) {
    if (files.length === 0) return;
    
    // We upload files sequentially or single zip
    // Let's filter for .dat, .sii, .zip
    const allowedExtensions = ['.dat', '.sii', '.zip'];
    const filesToUpload = Array.from(files).filter(file => {
        const name = file.name.toLowerCase();
        return allowedExtensions.some(ext => name.endsWith(ext));
    });
    
    if (filesToUpload.length === 0) {
        showToast('Csak .dat, .sii vagy .zip fájlokat tölthetsz fel!', 'error');
        return;
    }

    // Upload first matching file (or multiple in loop)
    // Multer expects one file per request in upload.single('file')
    uploadFile(filesToUpload[0]);
}

function uploadFile(file) {
    uploadProgressContainer.style.display = 'block';
    uploadResult.style.display = 'none';
    uploadProgressBar.style.width = '0%';
    uploadStatusText.innerText = 'Feltöltés: 0%';
    
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append('file', file);
    
    xhr.open('POST', `/api/upload/${activeGame}`, true);
    
    // Progress tracker
    xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
            const percentComplete = Math.round((e.loaded / e.total) * 100);
            uploadProgressBar.style.width = `${percentComplete}%`;
            uploadStatusText.innerText = `Feltöltés: ${percentComplete}%`;
        }
    });
    
    xhr.addEventListener('load', () => {
        uploadProgressContainer.style.display = 'none';
        
        try {
            const response = JSON.parse(xhr.responseText);
            if (xhr.status === 200) {
                showToast(response.message || 'Sikeres feltöltés!');
                uploadResult.style.className = 'alert-info';
                uploadResult.style.display = 'block';
                uploadResult.innerText = response.message || 'Fájl feltöltve!';
                
                // Refresh config to check new file status
                fetchConfig();
            } else {
                showToast(response.error || 'Hiba történt', 'error');
                uploadResult.className = 'alert-info error';
                uploadResult.style.display = 'block';
                uploadResult.innerText = response.error || 'Feltöltési hiba';
            }
        } catch (e) {
            showToast('Nem sikerült elemezni a válaszüzenetet.', 'error');
        }
    });
    
    xhr.addEventListener('error', () => {
        uploadProgressContainer.style.display = 'none';
        showToast('Kapcsolódási hiba történt a feltöltés alatt.', 'error');
    });
    
    xhr.send(formData);
}
