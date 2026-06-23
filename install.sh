#!/usr/bin/env bash

# Automated Installer for ETS2 and ATS Dedicated Servers on Arch Linux
# Runs as a normal user (no root required by default)

set -euo pipefail

# Colors for modern terminal UI
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Dynamic configurations based on executing user
INSTALL_USER=$(whoami)
INSTALL_GROUP=$(id -gn)
INSTALL_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

STEAM_USER="$INSTALL_USER"
STEAM_GROUP="$INSTALL_GROUP"
STEAM_HOME="$INSTALL_HOME"

STEAMCMD_DIR="$STEAM_HOME/steamcmd"
STEAMCMD_BIN="$STEAMCMD_DIR/steamcmd.sh"

ETS2_APP_ID="1948160"
ATS_APP_ID="2239530"

ETS2_INSTALL_DIR="$STEAM_HOME/ets2-server"
ATS_INSTALL_DIR="$STEAM_HOME/ats-server"

ETS2_DATA_DIR="$STEAM_HOME/ets2-data"
ATS_DATA_DIR="$STEAM_HOME/ats-data"

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

# Header UI
show_header() {
    clear
    echo -e "${BOLD}${CYAN}"
    echo "=========================================================="
    echo "  SCS DEDICATED SERVER AUTOMATED INSTALLER FOR ARCH LINUX "
    echo "         Euro Truck Simulator 2 & American Truck Simulator"
    echo "=========================================================="
    echo -e "${NC}"
    log_info "Futtató felhasználó: ${BOLD}$INSTALL_USER${NC} (Home: $INSTALL_HOME)"
}

# 1. Check if OS is Arch Linux
check_os() {
    if [ ! -f /etc/arch-release ]; then
        log_warn "Úgy tűnik, ez a rendszer nem Arch Linux."
        echo -n "Szeretnéd folytatni ennek ellenére? [y/N]: "
        read -r response
        if [[ ! "$response" =~ ^[yY]$ ]]; then
            log_info "Telepítés megszakítva."
            exit 1
        fi
    fi
}

# 2. Check multilib repository (required for 32-bit steamcmd)
check_multilib() {
    log_info "Rendszer multilib tároló ellenőrzése..."
    
    if command -v pacman &> /dev/null; then
        if ! pacman -Si lib32-glibc &> /dev/null; then
            log_warn "A multilib tároló nincs engedélyezve a rendszeren!"
            log_warn "Kérlek engedélyezd a [multilib] tárolót az /etc/pacman.conf fájlban,"
            log_warn "majd futtasd a 'sudo pacman -Sy' parancsot."
            echo ""
            echo -n "Folytatod a telepítést ennek ellenére? [y/N]: "
            read -r response
            if [[ ! "$response" =~ ^[yY]$ ]]; then
                log_info "Telepítés leállítva."
                exit 1
            fi
        else
            log_success "A multilib tároló elérhető."
        fi
    else
        log_warn "A csomagkezelő nem elérhető, multilib ellenőrzés átugorva."
    fi
}

# 3. Check dependencies (only check and list missing packages, do not auto-install)
check_dependencies() {
    log_info "Szükséges függőségek ellenőrzése..."
    
    local missing_pkgs=()
    local pkgs=(
        "lib32-gcc-libs"
        "lib32-glibc"
        "wget"
        "tar"
        "screen"
        "git"
        "unzip"
        "rsync"
        "nodejs"
        "npm"
    )
    
    if command -v pacman &> /dev/null; then
        for pkg in "${pkgs[@]}"; do
            if ! pacman -Qi "$pkg" &>/dev/null; then
                missing_pkgs+=("$pkg")
            fi
        done
    else
        log_warn "A 'pacman' csomagkezelő nem található. A függőségek ellenőrzése manuálisan szükséges."
        return 0
    fi
    
    if [ ${#missing_pkgs[@]} -ne 0 ]; then
        log_warn "Az alábbi szükséges csomagok hiányoznak a rendszerről:"
        for pkg in "${missing_pkgs[@]}"; do
            echo -e "  - ${RED}${pkg}${NC}"
        done
        echo ""
        log_warn "Kérlek, telepítsd őket manuálisan az alábbi paranccsal:"
        echo -e "  ${BOLD}sudo pacman -S ${missing_pkgs[*]}${NC}"
        echo ""
        echo -n "Szeretnéd folytatni a telepítést a hiányzó csomagok ellenére? [y/N]: "
        read -r response
        if [[ ! "$response" =~ ^[yY]$ ]]; then
            log_info "Telepítés megszakítva."
            exit 1
        fi
    else
        log_success "Minden szükséges függőség telepítve van!"
    fi
}

# 4. Install SteamCMD
install_steamcmd() {
    if [ ! -f "$STEAMCMD_BIN" ]; then
        log_info "SteamCMD letöltése és telepítése..."
        mkdir -p "$STEAMCMD_DIR"
        wget -qO- "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz" | tar -zxvf - -C "$STEAMCMD_DIR"
        
        log_info "SteamCMD frissítése (első futtatás)..."
        "$STEAMCMD_BIN" +quit
        log_success "SteamCMD telepítve és frissítve!"
    else
        log_info "SteamCMD már telepítve van."
    fi
    
    # Setup Steam SDK symlink for 64-bit games
    log_info "64-bites Steam SDK könyvtárstruktúra és symlink beállítása..."
    mkdir -p "$STEAM_HOME/.steam/sdk64"
    if [ -f "$STEAMCMD_DIR/linux64/steamclient.so" ]; then
        ln -sf "$STEAMCMD_DIR/linux64/steamclient.so" "$STEAM_HOME/.steam/sdk64/steamclient.so"
        log_success "Steam SDK symlink sikeresen beállítva."
    else
        log_warn "A steamclient.so még nem jött létre. A játékok letöltése után újra megpróbáljuk."
    fi
}

# 5. Install/Update Game Server
install_game_server() {
    local game=$1
    local app_id=""
    local install_dir=""
    local game_name=""
    
    if [ "$game" == "ets2" ]; then
        app_id=$ETS2_APP_ID
        install_dir=$ETS2_INSTALL_DIR
        game_name="Euro Truck Simulator 2 Dedicated Server"
    else
        app_id=$ATS_APP_ID
        install_dir=$ATS_INSTALL_DIR
        game_name="American Truck Simulator Dedicated Server"
    fi
    
    log_info "Szerver letöltése/frissítése: $game_name ($install_dir)..."
    mkdir -p "$install_dir"
    
    "$STEAMCMD_BIN" \
        +force_install_dir "$install_dir" \
        +login anonymous \
        +app_update "$app_id" validate \
        +quit
        
    log_success "$game_name fájlok letöltve!"
}

# 6. Generate Default Configurations
generate_default_configs() {
    local game=$1
    local server_bin=""
    local data_dir=""
    local sub_dir_name=""
    local game_title=""
    
    if [ "$game" == "ets2" ]; then
        server_bin="$ETS2_INSTALL_DIR/bin/linux_x64/eurotrucks2_server"
        data_dir=$ETS2_DATA_DIR
        sub_dir_name="Euro Truck Simulator 2"
        game_title="Euro Truck Simulator 2"
    else
        server_bin="$ATS_INSTALL_DIR/bin/linux_x64/amtrucks_server"
        data_dir=$ATS_DATA_DIR
        sub_dir_name="American Truck Simulator"
        game_title="American Truck Simulator"
    fi
    
    local config_file="$data_dir/$sub_dir_name/server_config.sii"
    
    if [ -f "$config_file" ]; then
        log_info "A konfigurációs fájl már létezik a(z) $game_title szerverhez."
        return 0
    fi
    
    log_info "Alapértelmezett konfigurációs fájlok generálása ($game_title)..."
    mkdir -p "$data_dir"
    
    if [ -f "$server_bin" ]; then
        # Launch server in background to generate config files
        log_info "Szerver ideiglenes elindítása (kb 4 másodperc)..."
        LD_LIBRARY_PATH="$STEAMCMD_DIR/linux64" "$server_bin" -homedir "$data_dir" > /dev/null 2>&1 &
        local pid=$!
        sleep 4
        kill $pid || true
        
        # Verify
        if [ -f "$config_file" ]; then
            log_success "Sikeresen legenerálva: $config_file"
        else
            log_warn "A konfiguráció nem jött létre automatikusan. Lehet, hogy kézzel kell futtatnod először."
        fi
    else
        log_warn "A szerver bináris nem található a következő helyen: $server_bin"
    fi
}

# 7. Setup Web Dashboard
setup_webpanel() {
    log_info "Web Dashboard telepítése..."
    local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    
    if [ -d "$script_dir/webpanel" ]; then
        log_info "Webpanel Node.js függőségek telepítése helyben (npm install)..."
        cd "$script_dir/webpanel"
        npm install
        cd "$script_dir"
        
        log_success "Web Dashboard függőségek sikeresen telepítve helyben!"
    else
        log_error "Nem található a webpanel könyvtár: $script_dir/webpanel"
    fi
}

# Helper to generate service files in /tmp
generate_service_files() {
    cat << EOF > /tmp/ets2server.service
[Unit]
Description=Euro Truck Simulator 2 Dedicated Server
After=network.target

[Service]
Type=simple
User=$INSTALL_USER
Group=$INSTALL_GROUP
WorkingDirectory=$STEAM_HOME/ets2-server/bin/linux_x64
Environment="LD_LIBRARY_PATH=$STEAM_HOME/steamcmd/linux64"
ExecStart=$STEAM_HOME/ets2-server/bin/linux_x64/eurotrucks2_server -homedir $STEAM_HOME/ets2-data
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

    cat << EOF > /tmp/atsserver.service
[Unit]
Description=American Truck Simulator Dedicated Server
After=network.target

[Service]
Type=simple
User=$INSTALL_USER
Group=$INSTALL_GROUP
WorkingDirectory=$STEAM_HOME/ats-server/bin/linux_x64
Environment="LD_LIBRARY_PATH=$STEAM_HOME/steamcmd/linux64"
ExecStart=$STEAM_HOME/ats-server/bin/linux_x64/amtrucks_server -homedir $STEAM_HOME/ats-data
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

    cat << EOF > /tmp/truck-webpanel.service
[Unit]
Description=SCS Server Manager Web Dashboard
After=network.target

[Service]
Type=simple
User=$INSTALL_USER
Group=$INSTALL_GROUP
WorkingDirectory=$STEAM_HOME/webpanel
Environment="PORT=8081"
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
}

# 8. Setup Systemd Services (Optional, prompts for sudo)
setup_systemd_services() {
    echo -n "Szeretnéd telepíteni a Systemd szolgáltatásokat az automatikus háttérben való futtatáshoz? (Root/Sudo jelszót fog kérni) [y/N]: "
    read -r response
    if [[ "$response" =~ ^[yY]$ ]]; then
        log_info "Systemd szolgáltatások és Sudoers szabályok generálása..."
        generate_service_files
        
        # Copy to systemd directory using sudo
        log_info "Fájlok másolása a /etc/systemd/system/ mappába..."
        sudo cp /tmp/ets2server.service /etc/systemd/system/
        sudo cp /tmp/atsserver.service /etc/systemd/system/
        sudo cp /tmp/truck-webpanel.service /etc/systemd/system/
        
        sudo chmod 644 /etc/systemd/system/ets2server.service
        sudo chmod 644 /etc/systemd/system/atsserver.service
        sudo chmod 644 /etc/systemd/system/truck-webpanel.service
        
        sudo systemctl enable truck-webpanel.service
        sudo systemctl restart truck-webpanel.service || sudo systemctl start truck-webpanel.service
        log_success "Systemd szolgáltatások sikeresen konfigurálva!"
        
        log_info "Sudoers szabályok beállítása a '$INSTALL_USER' felhasználónak..."
        sudo mkdir -p /etc/sudoers.d
        sudo tee "/etc/sudoers.d/truck-server-$INSTALL_USER" << EOF
$INSTALL_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl start ets2server.service, /usr/bin/systemctl stop ets2server.service, /usr/bin/systemctl restart ets2server.service, /usr/bin/systemctl status ets2server.service, /usr/bin/systemctl start atsserver.service, /usr/bin/systemctl stop atsserver.service, /usr/bin/systemctl restart atsserver.service, /usr/bin/systemctl status atsserver.service, /usr/bin/systemctl start truck-webpanel.service, /usr/bin/systemctl stop truck-webpanel.service, /usr/bin/systemctl restart truck-webpanel.service, /usr/bin/systemctl status truck-webpanel.service
EOF
        sudo chmod 440 "/etc/sudoers.d/truck-server-$INSTALL_USER"
        log_success "Sudoers szabályok sikeresen beállítva."
        
        sudo systemctl daemon-reload
        log_success "Systemd démonok újraolvasva."
        
        # Clean up
        rm -f /tmp/ets2server.service /tmp/atsserver.service /tmp/truck-webpanel.service
    else
        log_info "Systemd szolgáltatások telepítése kihagyva."
        log_info "A webpanelt manuálisan az alábbi paranccsal tudod elindítani:"
        log_info "  PORT=8081 node $STEAM_HOME/webpanel/server.js"
    fi
}

# 9. Install Management CLI (Optional, prompts for sudo)
install_management_cli() {
    local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    
    echo -n "Szeretnéd telepíteni a 'truck-server' parancssoros eszközt? (/usr/local/bin/truck-server - Sudo jelszót fog kérni) [y/N]: "
    read -r response
    if [[ "$response" =~ ^[yY]$ ]]; then
        if [ -f "$script_dir/truck-server" ]; then
            # Custom paths replacement matching current user configuration
            sed -e "s|STEAM_USER=\"steam\"|STEAM_USER=\"$INSTALL_USER\"|g" \
                -e "s|/home/steam|$STEAM_HOME|g" \
                "$script_dir/truck-server" > /tmp/truck-server-custom
                
            sudo cp /tmp/truck-server-custom /usr/local/bin/truck-server
            sudo chmod +x /usr/local/bin/truck-server
            rm -f /tmp/truck-server-custom
            log_success "A 'truck-server' parancs sikeresen telepítve a /usr/local/bin mappába!"
        else
            log_error "Nem található a truck-server kezelőeszköz fájlja."
        fi
    else
        log_info "A CLI eszköz telepítése kihagyva. A szkriptet közvetlenül is futtathatod: $script_dir/truck-server"
    fi
}

# 10. Final instructions
show_finish_screen() {
    echo -e "\n${BOLD}${GREEN}==========================================================${NC}"
    echo -e "${BOLD}${GREEN}            A TELEPÍTÉS SIKERESEN BEFEJEZŐDÖTT!            ${NC}"
    echo -e "${BOLD}${GREEN}==========================================================${NC}\n"
    
    echo -e "A szervereket kezelheted a ${BOLD}truck-server${NC} segédprogrammal a terminálból (ha telepítetted),"
    echo -e "vagy a grafikus webes felületen keresztül a böngésződben:"
    echo -e "  --> ${BOLD}${CYAN}http://localhost:8081${NC} <--\n"
    
    echo -e "Ha nem telepítetted a systemd szolgáltatásokat, a webpanelt manuálisan így indíthatod el:"
    echo -e "  ${YELLOW}PORT=8081 node $STEAM_HOME/webpanel/server.js${NC}\n"
    
    echo -e "${BOLD}Fontos következő lépések:${NC}"
    echo -e " 1. ${BOLD}Szerver Csomagok (server_packages) Exportálása:${NC}"
    echo -e "    Ahhoz, hogy a szerver elinduljon a térképeddel és dlc-iddel, a kliensedből"
    echo -e "    ki kell exportálnod a fájlokat."
    echo -e "    - A játékban engedélyezd a konzolt (config.cfg-ben: g_console \"1\", g_developer \"1\")."
    echo -e "    - A játék betöltése után nyisd meg a konzolt (~ gomb) és írd be: ${CYAN}export_server_packages${NC}"
    echo -e "    - Ez létrehoz két fájlt: ${BOLD}server_packages.dat${NC} és ${BOLD}server_packages.sii${NC}."
    echo -e "    - Ezt a két fájlt (vagy egy zip-et belőlük) egyszerűen ${BOLD}húzd rá a böngészőben${NC}"
    echo -e "      a webes felület ${YELLOW}Modok & Szerver Csomagok${NC} feltöltő zónájára!\n"
    
    echo -e " 2. ${BOLD}Konfiguráció és Szerver Token:${NC}"
    echo -e "    Állítsd be a szerver tulajdonságait a webes felület ${YELLOW}Űrlap Szerkesztőjében${NC}."
    echo -e "    Generálj tokent a játék App ID-jával (ETS2 = 227300, ATS = 270880) itt:"
    echo -e "    https://steamcommunity.com/dev/managegameservers"
    echo -e "    és illeszd be a webes felületen a token mezőbe.\n"
    
    echo -e " 3. ${BOLD}Szerver Indítása:${NC}"
    echo -e "    Kattints az ${BOLD}Indítás${NC} gombra a webes felületen, vagy indítsd el terminálból:"
    echo -e "      ${YELLOW}truck-server start ets2${NC}\n"
    echo -e "Kellemes kamionozást! :)"
}

# Main Execution Flow
main() {
    show_header
    check_os
    
    echo -e "Mit szeretnél telepíteni?"
    echo "  1) Euro Truck Simulator 2 Dedicated Server"
    echo "  2) American Truck Simulator Dedicated Server"
    echo "  3) Mindkettő (Euro és American Truck Simulator)"
    echo "  4) Csak a rendszerszintű beállítások (Szerver előfeltételek, Webpanel és eszközök)"
    echo -n "Válassz egy opciót [1-4]: "
    read -r choice
    
    if [[ ! "$choice" =~ ^[1-4]$ ]]; then
        log_error "Érvénytelen választás!"
        exit 1
    fi
    
    check_multilib
    check_dependencies
    install_steamcmd
    setup_webpanel
    
    # Install specific games
    case "$choice" in
        1)
            install_game_server "ets2"
            generate_default_configs "ets2"
            ;;
        2)
            install_game_server "ats"
            generate_default_configs "ats"
            ;;
        3)
            install_game_server "ets2"
            generate_default_configs "ets2"
            install_game_server "ats"
            generate_default_configs "ats"
            ;;
        4)
            log_info "Csak az előfeltételek és a kezelőeszközök kerülnek telepítésre..."
            ;;
    esac
    
    # Ensure sdk64 link is set up if files now exist
    if [ -f "$STEAMCMD_DIR/linux64/steamclient.so" ]; then
        ln -sf "$STEAMCMD_DIR/linux64/steamclient.so" "$STEAM_HOME/.steam/sdk64/steamclient.so"
    fi
    
    setup_systemd_services
    install_management_cli
    show_finish_screen
}

main "$@"
