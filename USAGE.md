# Yurrr Password Manager — Usage Guide

## Architecture

```
[Arch Laptop w/ Brave]  --HTTPS-->  [Raspberry Pi Server]
     (extension)                     (Rust + SQLite)
```

The Rust server runs on your Raspberry Pi and stores encrypted passwords in SQLite.
The Brave extension on your Arch laptop connects to it over your local network.

---

## Part 1: Raspberry Pi (Server)

### Prerequisites

Rust is already installed. If you ever need to reinstall:
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env
```

### First-Time Build

```bash
cd ~/vube/yurrr/server
cargo build --release
```

This takes a while on the Pi (~10-15 min first time). The release binary lands at
`target/release/yurrr-server`.

### Running the Server

```bash
cd ~/vube/yurrr/server
cargo run --release
```

Or run the binary directly:
```bash
cd ~/vube/yurrr/server
./target/release/yurrr-server
```

On first start, the server will:
1. Create `vault.db` (SQLite database)
2. Generate a self-signed TLS cert in `certs/`
3. Start listening on `https://0.0.0.0:8443`

### Run as a systemd Service (Auto-Start on Boot)

Create the service file:
```bash
sudo tee /etc/systemd/system/yurrr.service << 'EOF'
[Unit]
Description=Yurrr Password Manager Server
After=network.target

[Service]
Type=simple
User=piper
WorkingDirectory=/home/piper/vube/yurrr/server
ExecStart=/home/piper/vube/yurrr/server/target/release/yurrr-server
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable yurrr
sudo systemctl start yurrr
```

Check status:
```bash
sudo systemctl status yurrr
```

View logs:
```bash
journalctl -u yurrr -f
```

### Verify It Works

From the Pi itself:
```bash
curl -sk https://localhost:8443/api/v1/auth/status
```

Should return:
```json
{"initialized":false,"server_version":"0.1.0"}
```

### Find Your Pi's IP Address

```bash
hostname -I
```

Your Pi's LAN IPs are:
- **Ethernet:** `10.187.187.102`
- **WiFi:** `10.187.187.106`
- **Tailscale:** `100.118.2.12`

Use whichever is reachable from your laptop. If both devices are on Tailscale,
use the Tailscale IP for access from anywhere.

### Firewall (If Applicable)

If you run a firewall, allow port 8443:
```bash
sudo ufw allow 8443/tcp
```

---

## Part 2: Arch Laptop (Brave Extension)

### Step 1: Accept the Self-Signed Certificate

Before the extension can talk to the server, Brave needs to trust the cert.

1. Open Brave
2. Navigate to: `https://<PI_IP>:8443/api/v1/auth/status`
   - Example: `https://10.187.187.102:8443/api/v1/auth/status`
   - Or via Tailscale: `https://100.118.2.12:8443/api/v1/auth/status`
3. You'll see a security warning — click **Advanced** → **Proceed to ... (unsafe)**
4. You should see: `{"initialized":false,"server_version":"0.1.0"}`

**You only need to do this once** (per browser profile). Brave remembers the exception.

### Step 2: Get the Extension Files

Copy the extension folder from the Pi to your laptop. Options:

**Option A — scp:**
```bash
scp -r piper@10.187.187.102:~/vube/yurrr/extension ~/yurrr-extension
```

**Option B — rsync:**
```bash
rsync -avz piper@10.187.187.102:~/vube/yurrr/extension/ ~/yurrr-extension/
```

**Option C — git:**
If you set up a git repo, clone it on both machines.

### Step 3: Load the Extension in Brave

1. Open Brave and go to `brave://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder (e.g., `~/yurrr-extension`)
5. The Yurrr icon (green square) appears in your toolbar

### Step 4: Configure the Server URL

1. Right-click the Yurrr extension icon → **Options**
   (or click the ⋮ menu on the extension card → **Options**)
2. Set the Server URL to your Pi's address:
   ```
   https://10.187.187.102:8443
   ```
   Or if using Tailscale:
   ```
   https://100.118.2.12:8443
   ```
3. Click **Test Connection** — should show "Connected!"
4. Click **Save**

### Step 5: Initialize the Vault

1. Click the Yurrr extension icon in the toolbar
2. The status dot should be green (server reachable)
3. Since the vault isn't initialized yet, you'll see **"Initialize Vault"**
4. Enter a strong master password (8+ characters) and click **Initialize Vault**
5. Now enter the same password and click **Unlock**

### Step 6: Start Using It

**Add a password manually:**
1. Click the **+** button in the popup
2. Fill in the website URL, username, and password
3. Use the dice icon to generate a secure password
4. Click **Save**

**Auto-fill on websites:**
1. Visit a login page (e.g., github.com)
2. If you have saved credentials for that site, Yurrr auto-fills them
3. If it's a registration form, Yurrr shows a password suggestion dropdown

**Save passwords from forms:**
1. When you submit a login/signup form, Yurrr shows a banner at the top
2. Click **Save** to store the credentials

**Search passwords:**
1. Open the popup and type in the search bar
2. Filters by website domain or username

**Copy credentials:**
1. Click an entry to view details
2. Click the clipboard icon next to username or password to copy
3. Click the eye icon to reveal/hide the password

---

## Everyday Workflow

1. **Pi runs 24/7** with the server as a systemd service
2. **Open Brave** on your laptop — extension is always ready
3. **Click Yurrr icon** → enter master password to unlock
4. **Browse normally** — Yurrr auto-fills login forms
5. **Auto-locks after 15 minutes** of inactivity (server-side + extension-side)

---

## Security Notes

- All passwords are encrypted with **AES-256-GCM** before storage
- The encryption key is derived from your master password via **Argon2id**
- The key only exists in server RAM during your session — never written to disk
- **Restarting the server kills all sessions** (JWT signing key is in-memory only)
- The database file (`vault.db`) contains only encrypted passwords
- Communication is always over **HTTPS/TLS** (even the self-signed cert encrypts traffic)

---

## Troubleshooting

### "Connection failed" in extension
- Make sure the server is running: `sudo systemctl status yurrr`
- Make sure you accepted the cert in Brave (Step 1 above)
- Make sure the server URL in extension options is correct
- Check firewall allows port 8443

### Login takes a long time
- Argon2id is CPU-intensive, especially on the Pi
- The config is already tuned down for Pi (16 MB memory, 2 iterations)
- First login after server start is slower; subsequent ones use the same session

### "Session expired" errors
- Your session expired (1 hour max, or 15 min inactivity)
- Just unlock again with your master password

### Extension not detecting forms
- Some sites use non-standard login forms (shadow DOM, iframes)
- You can always add/copy credentials manually via the popup

### Updating the extension after changes
- Copy the updated files to your laptop
- Go to `brave://extensions` and click the refresh icon on the Yurrr card
