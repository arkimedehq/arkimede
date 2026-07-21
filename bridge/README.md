# Arkimede Bridge

The bridge is a desktop application that connects the **Arkimede** server (remote) to the **local MCP programs** installed on your PC, such as FreeCad, filesystem tools, local databases and any other MCP server that runs as a `stdio` process.

---

## How it works

```
[Local program]  ←stdio→  [Bridge]  ←WebSocket→  [Arkimede server]  ←→  [AI agent]
    npx freecad-mcp                                 remote/cloud
```

1. The bridge opens a secure WebSocket channel to the server
2. It receives from the server the list of "local" MCP servers you configured in the web interface
3. It starts those processes on your PC and talks to them in JSON-RPC via stdin/stdout
4. When the AI agent wants to use a local tool, the server asks the bridge, the bridge asks the process and returns the answer

---

## Installation

### Download the pre-built package

| System | File to download |
|---------|-------------------|
| Windows | `Arkimede-Bridge-Setup-x.x.x.exe` |
| macOS (Apple Silicon) | `Arkimede-Bridge-x.x.x-arm64.dmg` |
| macOS (Intel) | `Arkimede-Bridge-x.x.x.dmg` |
| Linux | `Arkimede-Bridge-x.x.x.AppImage` |

Use the **Download bridge** button in **Settings → MCP Servers** in the web interface:
it opens the latest GitHub Release, where the installers above are attached. On a Mac,
pick `-arm64` for Apple Silicon (M1/M2/M3…) or the plain `.dmg` for older Intel Macs.

### Opening the app the first time (unsigned build)

The public builds are **not code-signed** (signing requires paid Apple/Windows
certificates), so the OS shows a warning on first launch. This is expected — open it
once as below and it won't ask again:

**macOS** — double-clicking shows *"Arkimede Bridge cannot be opened because the
developer cannot be verified"*. Do one of:
- **Right-click** (or Ctrl-click) the app → **Open** → **Open** in the dialog; **or**
- after the first blocked attempt, go to **System Settings → Privacy & Security** and
  click **Open Anyway**; **or**
- from a terminal: `xattr -dr com.apple.quarantine "/Applications/Arkimede Bridge.app"`.

**Windows** — SmartScreen shows *"Windows protected your PC"*. Click **More info** →
**Run anyway**.

**Linux** — make the AppImage executable, then run it:
```bash
chmod +x Arkimede-Bridge-x.x.x.AppImage
./Arkimede-Bridge-x.x.x.AppImage
```

### Or run in development mode

```bash
cd bridge
npm install
npm run dev
```

---

## First launch

On opening you will see the main window with the sidebar on the left and the dashboard on the right.

### Step 1 — Get your JWT token

Open the Arkimede web interface in your browser and go to **Settings → Account** (or **Profile**).  
Copy the JWT token of your session.

> **Quick alternative:** you can copy it from the browser's localStorage.  
> Open DevTools → Application → Local Storage → `arkimede-store` → look for the `token` field.

### Step 2 — Configure the bridge

Click the **⚙ Settings** button at the bottom left of the sidebar.

Fill in the two fields:

| Field | What to enter | Example |
|-------|---------------|---------|
| **Server URL** | WebSocket address of the Arkimede server | `wss://yourserver.com` or `ws://localhost:3000` locally |
| **JWT Token** | The token copied in step 1 | `eyJhbGci...` |

Click **Test connection** to verify that everything works.  
If you see **"Connection successful!"** click **Save**.

> ⚠️ Use `wss://` (secure WebSocket) if the server is on HTTPS, `ws://` if it is local.

### Step 3 — Enable auto-start (optional)

On the same Settings screen enable **"Start with the system"** so that the bridge starts automatically every time you turn on your PC.

---

## Adding local MCP servers

Local MCP servers are configured from the **web interface**, not from the bridge.

1. Go to **Settings → MCP Servers** in the web app
2. Click **Add server**
3. Choose the **Local** type (monitor icon)
4. Enter the **command** to run

### Command examples

| MCP Server | Command | Requirement |
|------------|---------|-------------|
| Filesystem | `npx -y @modelcontextprotocol/server-filesystem /path/folder` | Node.js |
| Tavily (local) | `npx -y tavily-mcp` | Node.js |
| FreeCad | `uvx freecad-mcp` | Python + uv |
| SQLite | `npx -y @modelcontextprotocol/server-sqlite /path/db.sqlite` | Node.js |
| Git | `npx -y @cline/mcp-server-git` | Node.js |

> `npx -y` commands download and start the package automatically with no manual installation.  
> `uvx` commands do the same with Python packages.

### What happens next

1. You save the MCP server in the web interface
2. The server automatically sends the updated configuration to the bridge (if it is connected)
3. The bridge starts the process on your PC
4. In the bridge's **Dashboard** tab you will see the server appear with the **running** status 🟢
5. The server's tools appear in the AI agent

---

## Interface tabs

### Dashboard
Shows the status of the connection to the server and the list of active local MCP servers with the number of available tools and their status.

### Log
Real-time log of every operation: WebSocket connections, process startup, tool calls, errors. Useful for debugging.

### Dependencies
Checks that the required programs are installed on your PC:

| Dependency | Used for | How to install it |
|------------|----------|-------------------|
| **Node.js / npx** | npm MCP servers | [nodejs.org](https://nodejs.org) |
| **Python 3 / pip** | Python MCP servers | [python.org](https://www.python.org/downloads/) |
| **uv / uvx** | Fast Python MCP servers | `curl -LsSf https://astral.sh/uv/install.sh \| sh` (Mac/Linux) |

Dependencies with ✅ are available, those with ❌ are not and the bridge shows the instructions to install them.

---

## System tray icon

After closing the window, the bridge keeps running in the notification area (tray):

| Icon | Status |
|-------|-------|
| 🟢 green circle | Connected to the server |
| 🔴 red circle | Not connected |
| 🟡 blinking yellow circle | Connecting |

Right-click the icon to open the menu:
- **Open window** — reopens the main window
- **Start with [OS]** — toggle autostart
- **Quit** — completely closes the bridge

---

## Troubleshooting

### The bridge can't connect

- Verify that the Arkimede server is running and reachable
- Check that the URL starts with `ws://` or `wss://` (not `http://`)
- Make sure the JWT token has not expired (tokens expire every 7 days by default — log in again and copy the new token)
- Check that port `3000` (or the configured one) is not blocked by the firewall

### A local MCP server does not start

1. Open the **Log** tab and look for the error message
2. Open the **Dependencies** tab and verify that `npx`/`uvx` are installed
3. Try the command manually in the terminal to see the full error:
   ```bash
   npx -y @modelcontextprotocol/server-filesystem /path
   ```

### The bridge does not stay in the background on Linux

On some Linux distributions `libappindicator` is not installed and the tray icon does not work. Install:
```bash
# Ubuntu/Debian
sudo apt install libayatana-appindicator3-1

# Fedora
sudo dnf install libappindicator-gtk3
```

---

## For developers

### Project structure

```
bridge/
├── src/
│   ├── main/                 # Electron main process (Node.js)
│   │   ├── index.ts          # Entry point, window and IPC management
│   │   ├── bridge.ts         # WebSocket connection to the server
│   │   ├── mcp-process.ts    # Spawn and management of MCP stdio processes
│   │   ├── tray.ts           # System tray icon
│   │   ├── autostart.ts      # Auto-start at login
│   │   ├── deps-checker.ts   # OS dependency check
│   │   └── app.config.ts     # App name (edit for rebranding)
│   ├── preload/
│   │   └── index.ts          # API exposed to the renderer via contextBridge
│   └── renderer/             # React interface
│       ├── App.tsx
│       └── components/
│           ├── ConnectionCard.tsx
│           ├── ServersList.tsx
│           ├── LogPanel.tsx
│           ├── DepsPanel.tsx
│           └── SettingsModal.tsx
├── electron-builder.yml      # Packaging configuration
└── package.json
```

### Commands

```bash
npm run dev        # Start in development mode (hot reload)
npm run build      # Compile + build installer for your OS
npm run dist       # Only build installer (without compiling)
npm run pack       # Build unpackaged directory (for testing)
```

### Customizing the app name

Edit `src/main/app.config.ts`:
```typescript
export const APP_NAME   = 'YourAppName'
export const APP_ID     = 'com.yourappname.bridge'
export const BRIDGE_NAME = `${APP_NAME} Bridge`
```

And update `electron-builder.yml`:
```yaml
appId: com.yourappname.bridge
productName: YourAppName Bridge
```
