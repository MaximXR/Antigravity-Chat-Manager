const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const { getTranslation } = require('./locales/translations');

function getActiveLanguage() {
    const configLang = vscode.workspace.getConfiguration('antigravity-chat-manager').get('language', 'auto');
    if (configLang && configLang !== 'auto') {
        return configLang;
    }
    return vscode.env.language || 'en';
}

function logDebug(message) {
    try {
        const logPath = path.join(__dirname, 'extension_debug.log');
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
    } catch (e) {}
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('Antigravity Chat Manager activated.');

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'antigravity-chat-manager.open';
    updateStatusBarIcon(statusBarItem);
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Sync manifest icon on startup if needed
    updateManifestIcon(context);

    // Register Webview View Provider for the panel
    const provider = new ChatManagerViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('antigravity-chat-manager.view', provider)
    );

    // Monitor setting changes
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('antigravity-chat-manager.iconType') || e.affectsConfiguration('antigravity-chat-manager.language')) {
            updateManifestIcon(context);
            updateStatusBarIcon(statusBarItem);
            if (provider && provider._view) {
                provider._view.webview.html = getWebviewContent(getActiveLanguage());
            }
        }
    }, null, context.subscriptions);

    // Register command to focus/open the view in the bottom panel
    let disposable = vscode.commands.registerCommand('antigravity-chat-manager.open', function () {
        vscode.commands.executeCommand('antigravity-chat-manager.view.focus');
    });

    context.subscriptions.push(disposable);
}

// Helper to detect debugging ports from running processes command lines
async function detectPortsFromProcesses() {
    return new Promise((resolve) => {
        const isWin = process.platform === 'win32';
        let cmd = '';
        if (isWin) {
            cmd = 'wmic process where "name like \'%Antigravity%\'" get commandline';
        } else {
            cmd = 'ps aux | grep -i antigravity';
        }
        logDebug(`detectPortsFromProcesses: running command: ${cmd}`);
        cp.exec(cmd, (err, stdout) => {
            if (err) {
                logDebug(`detectPortsFromProcesses: primary command failed: ${err.message}`);
                if (isWin) {
                    const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name like '%Antigravity%'\\" | Select-Object -ExpandProperty CommandLine"`;
                    logDebug(`detectPortsFromProcesses: running fallback command: ${psCmd}`);
                    cp.exec(psCmd, (err2, stdout2) => {
                        if (err2) {
                            logDebug(`detectPortsFromProcesses: fallback command failed: ${err2.message}`);
                            resolve([]);
                        } else {
                            resolve(parsePorts(stdout2));
                        }
                    });
                } else {
                    resolve([]);
                }
            } else {
                resolve(parsePorts(stdout));
            }
        });
    });
}

function parsePorts(output) {
    const found = [];
    if (!output) return found;
    const regex = /--remote-debugging-port=(\d+)/g;
    let match;
    while ((match = regex.exec(output)) !== null) {
        const port = parseInt(match[1], 10);
        if (port && !found.includes(port)) {
            found.push(port);
        }
    }
    logDebug(`detectPortsFromProcesses: found ports: ${JSON.stringify(found)}`);
    return found;
}

class ChatManagerViewProvider {
    constructor(context) {
        this._context = context;
    }

    resolveWebviewView(webviewView, context, token) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(this._context.extensionPath)]
        };

        const activeLang = getActiveLanguage();
        webviewView.webview.html = getWebviewContent(activeLang);

        // Message listener (from Webview to extension host)
        webviewView.webview.onDidReceiveMessage(
            message => {
                const lang = getActiveLanguage();
                const webviewId = message.webviewId || '';
                logDebug(`resolveWebviewView: received message command="${message.command}" with webviewId="${webviewId}"`);
                switch (message.command) {
                    case 'reloadWindow':
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                        break;
                    case 'list':
                        this.getCurrentChatTitle(webviewId).then(currentTitle => {
                            logDebug(`resolveWebviewView: getCurrentChatTitle resolved with currentTitle="${currentTitle}"`);
                            const args = ['list'];
                            if (currentTitle) {
                                args.push(currentTitle);
                            }
                            this.runBackend(args, (success, data) => {
                                logDebug(`resolveWebviewView: runBackend returned success=${success}, data length=${data ? data.length : 0}`);
                                if (success) {
                                    webviewView.webview.postMessage({ command: 'listData', data: JSON.parse(data) });
                                } else {
                                    vscode.window.showErrorMessage(getTranslation('errList', lang) + data);
                                }
                            });
                        }).catch((err) => {
                            logDebug(`resolveWebviewView: getCurrentChatTitle failed with ${err ? err.message : 'unknown'}`);
                            this.runBackend(['list'], (success, data) => {
                                if (success) {
                                    webviewView.webview.postMessage({ command: 'listData', data: JSON.parse(data) });
                                } else {
                                    vscode.window.showErrorMessage(getTranslation('errList', lang) + data);
                                }
                            });
                        });
                        break;
                    case 'delete': {
                        const runDelete = (currentTitle) => {
                            const args = ['delete', message.uuid];
                            if (currentTitle) {
                                args.push(currentTitle);
                            }
                            this.runBackend(args, (success, data) => {
                                if (success) {
                                    const res = JSON.parse(data);
                                    if (res.success) {
                                        vscode.window.showInformationMessage(getTranslation('infoDeleted', lang).replace('{uuid}', message.uuid.substring(0, 8)).replace('{freed}', res.freed_str));
                                        // Trigger refresh
                                        webviewView.webview.postMessage({ command: 'actionSuccess', message: 'deleted' });
                                    } else {
                                        vscode.window.showErrorMessage(getTranslation('errDelete', lang) + res.error);
                                    }
                                } else {
                                    vscode.window.showErrorMessage(getTranslation('errBackend', lang) + data);
                                }
                            });
                        };
                        this.getCurrentChatTitle(webviewId)
                            .then(runDelete)
                            .catch(() => runDelete(null));
                        break;
                    }
                    case 'restore':
                        this.runBackend(['restore', message.uuid, message.title], (success, data) => {
                            if (success) {
                                const res = JSON.parse(data);
                                if (res.success) {
                                    vscode.window.showInformationMessage(getTranslation('infoRestored', lang).replace('{title}', res.title));
                                    // Trigger refresh
                                    webviewView.webview.postMessage({ command: 'actionSuccess', message: 'restored' });
                                } else {
                                    vscode.window.showErrorMessage(getTranslation('errRestore', lang) + res.error);
                                }
                            } else {
                                vscode.window.showErrorMessage(getTranslation('errBackend', lang) + data);
                            }
                        });
                        break;
                    case 'restoreAllOrphaned':
                        this.runBackend(['restore_all_orphaned'], (success, data) => {
                            if (success) {
                                const res = JSON.parse(data);
                                if (res.success) {
                                    vscode.window.showInformationMessage(getTranslation('infoRestoredCount', lang).replace('{count}', res.restored_count));
                                    webviewView.webview.postMessage({ command: 'actionSuccess', message: 'restored_all' });
                                } else {
                                    vscode.window.showErrorMessage(getTranslation('errRestore', lang) + (res.errors ? res.errors.join('; ') : getTranslation('cardUnknown', lang)));
                                }
                            } else {
                                vscode.window.showErrorMessage(getTranslation('errBackend', lang) + data);
                            }
                        });
                        break;
                    case 'deleteAllOrphaned': {
                        const runDeleteAll = (currentTitle) => {
                            const args = ['delete_all_orphaned'];
                            if (currentTitle) {
                                args.push(currentTitle);
                            }
                            this.runBackend(args, (success, data) => {
                                if (success) {
                                    const res = JSON.parse(data);
                                    if (res.success) {
                                        vscode.window.showInformationMessage(getTranslation('infoDeletedCount', lang).replace('{count}', res.deleted_count).replace('{freed}', res.freed_str));
                                        webviewView.webview.postMessage({ command: 'actionSuccess', message: 'deleted_all' });
                                    } else {
                                        vscode.window.showErrorMessage(getTranslation('errDelete', lang) + (res.errors ? res.errors.join('; ') : getTranslation('cardUnknown', lang)));
                                    }
                                } else {
                                    vscode.window.showErrorMessage(getTranslation('errBackend', lang) + data);
                                }
                            });
                        };
                        this.getCurrentChatTitle(webviewId)
                            .then(runDeleteAll)
                            .catch(() => runDeleteAll(null));
                        break;
                    }
                    case 'openSettings':
                        vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${this._context.extension.id}`);
                        break;
                    case 'copyToClipboard':
                        vscode.env.clipboard.writeText(message.text);
                        const label = message.label || getTranslation('cardNote', lang);
                        vscode.window.showInformationMessage(getTranslation('infoCopied', lang).replace('{label}', label));
                        break;
                    case 'saveNote':
                        this.runBackend(['save_note', message.uuid, message.note], (success, data) => {
                            if (success) {
                                const res = JSON.parse(data);
                                if (res.success) {
                                    webviewView.webview.postMessage({ command: 'actionSuccess', message: 'note_saved' });
                                } else {
                                    vscode.window.showErrorMessage(getTranslation('errSaveNote', lang) + res.error);
                                    webviewView.webview.postMessage({ command: 'actionSuccess', message: 'note_failed' });
                                }
                            } else {
                                vscode.window.showErrorMessage(getTranslation('errBackend', lang) + data);
                                webviewView.webview.postMessage({ command: 'actionSuccess', message: 'note_failed' });
                            }
                        });
                        break;
                    case 'openFolder': {
                        const homeDir = process.env.USERPROFILE || process.env.HOME;
                        const folderPath = path.join(homeDir, '.gemini', 'antigravity-ide', 'brain', message.uuid);
                        if (fs.existsSync(folderPath)) {
                            vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folderPath));
                        } else {
                            const geminiDir = path.join(homeDir, '.gemini', 'antigravity-ide');
                            if (process.platform === 'win32') {
                                cp.exec(`explorer "search-ms:query=${message.uuid}&crumb=location:${geminiDir}"`);
                            } else {
                                if (fs.existsSync(geminiDir)) {
                                    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(geminiDir));
                                } else {
                                    vscode.window.showWarningMessage(getTranslation('warnFolderNotFound', lang));
                                }
                            }
                        }
                        break;
                    }
                    case 'openSearch': {
                        const homeDir = process.env.USERPROFILE || process.env.HOME;
                        const geminiDir = path.join(homeDir, '.gemini', 'antigravity-ide');
                        if (process.platform === 'win32') {
                            cp.exec(`explorer "search-ms:query=${message.uuid}&crumb=location:${geminiDir}"`);
                        } else {
                            if (fs.existsSync(geminiDir)) {
                                vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(geminiDir));
                            } else {
                                vscode.window.showWarningMessage('Папка .gemini/antigravity-ide отсутствует.');
                            }
                        }
                        break;
                    }
                    case 'openProjectFolder':
                        if (message.path && fs.existsSync(message.path)) {
                            vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(message.path));
                        } else {
                            vscode.window.showWarningMessage(getTranslation('warnProjectFolderNotFound', lang));
                        }
                        break;
                    case 'changeLanguage':
                        vscode.workspace.getConfiguration('antigravity-chat-manager').update('language', message.language, vscode.ConfigurationTarget.Global);
                        break;
                    case 'activateChat':
                        this.activateChatSession(message.uuid, message.title, webviewId);
                        break;
                }
            }
        );
    }

    // Helper to run python backend process
    runBackend(args, callback) {
        const backendPath = path.join(this._context.extensionPath, 'backend.py');
        const run = (cmd) => {
            logDebug(`runBackend: starting child process ${cmd} with args=[${args.join(', ')}]`);
            cp.execFile(cmd, [backendPath, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
                logDebug(`runBackend: child process completed. error=${error ? error.message : null}, stdout_len=${stdout ? stdout.length : 0}, stderr_len=${stderr ? stderr.length : 0}`);
                if (error) {
                    // If python3 failed with ENOENT (command not found), try python as fallback
                    if (cmd === 'python3' && error.code === 'ENOENT') {
                        logDebug(`runBackend: python3 not found, falling back to python`);
                        run('python');
                    } else {
                        console.error('Backend execution error:', error, stderr);
                        callback(false, stderr || error.message);
                    }
                } else {
                    callback(true, stdout);
                }
            });
        };

        if (process.platform === 'win32') {
            run('python');
        } else {
            run('python3');
        }
    }


    // Discover the CDP debugging port of the current Antigravity instance
    async discoverCdpTarget(webviewId) {
    logDebug(`discoverCdpTarget: started with webviewId=${webviewId}`);
    const http = require('http');
    const getJson = (url) => {
        return new Promise((resolve, reject) => {
            logDebug(`getJson: requesting ${url}`);
            const req = http.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    logDebug(`getJson: received data from ${url}, length=${data.length}`);
                    try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
                });
            });
            req.setTimeout(500);
            req.on('timeout', () => {
                logDebug(`getJson: timeout requesting ${url}`);
                req.destroy();
                reject(new Error('timeout'));
            });
            req.on('error', (err) => {
                logDebug(`getJson: error requesting ${url}: ${err.message}`);
                reject(err);
            });
        });
    };

    let detectedPorts = [];
    try {
        detectedPorts = await detectPortsFromProcesses();
    } catch (e) {
        logDebug(`discoverCdpTarget: error detecting ports: ${e.message}`);
    }
    const ports = [...new Set([...detectedPorts, 9223, 9222, 9333, 9444, 9555, 9666])];
    logDebug(`discoverCdpTarget: ports to scan: ${JSON.stringify(ports)}`);

    // 1. Target specific webviewId matching
    if (webviewId) {
        logDebug(`discoverCdpTarget: checking specific webviewId=${webviewId}`);
        for (const port of ports) {
            try {
                const pages = await getJson(`http://localhost:${port}/json/list`);
                const hasSpecificWebview = pages.some(p => p.url && p.url.includes(`id=${webviewId}`));
                logDebug(`discoverCdpTarget: port ${port} hasSpecificWebview=${hasSpecificWebview}`);
                if (hasSpecificWebview) {
                    const workbench = pages.find(p => p.type === 'page' && p.url && p.url.includes('workbench.html'));
                    if (workbench) {
                        logDebug(`discoverCdpTarget: matched webviewId on port ${port}, workbench debugger url=${workbench.webSocketDebuggerUrl}`);
                        return { port, webSocketDebuggerUrl: workbench.webSocketDebuggerUrl };
                    }
                }
            } catch (e) {
                logDebug(`discoverCdpTarget: error on port ${port} during step 1: ${e.message}`);
            }
        }
    }

    // 2. Fallback to generic extension matching
    logDebug(`discoverCdpTarget: falling back to generic extension matching`);
    for (const port of ports) {
        try {
            const pages = await getJson(`http://localhost:${port}/json/list`);
            const hasOurExtension = pages.some(p => p.url && p.url.includes('antigravity-chat-manager'));
            logDebug(`discoverCdpTarget: port ${port} hasOurExtension=${hasOurExtension}`);
            if (hasOurExtension) {
                const workbench = pages.find(p => p.type === 'page' && p.url && p.url.includes('workbench.html'));
                if (workbench) {
                    logDebug(`discoverCdpTarget: matched generic on port ${port}, url=${workbench.webSocketDebuggerUrl}`);
                    return { port, webSocketDebuggerUrl: workbench.webSocketDebuggerUrl };
                }
            }
        } catch (e) {
            logDebug(`discoverCdpTarget: error on port ${port} during step 2: ${e.message}`);
        }
    }

    // 3. Fallback: use first available workbench on any port
    logDebug(`discoverCdpTarget: falling back to first available workbench`);
    for (const port of ports) {
        try {
            const pages = await getJson(`http://localhost:${port}/json/list`);
            const workbench = pages.find(p => p.type === 'page' && p.url && p.url.includes('workbench.html'));
            if (workbench) {
                logDebug(`discoverCdpTarget: matched fallback on port ${port}, url=${workbench.webSocketDebuggerUrl}`);
                return { port, webSocketDebuggerUrl: workbench.webSocketDebuggerUrl };
            }
        } catch (e) {
            logDebug(`discoverCdpTarget: error on port ${port} during step 3: ${e.message}`);
        }
    }
    logDebug(`discoverCdpTarget: failed to find any workbench page`);
    throw new Error(getTranslation('errDiscoverCdp', getActiveLanguage()));
}

evaluateScript(ws, expression) {
    logDebug(`evaluateScript: starting evaluation, expression="${expression.substring(0, 100)}..."`);
    return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1000000);
        const onMessage = (data) => {
            try {
                const res = JSON.parse(data);
                if (res.id === id) {
                    logDebug(`evaluateScript: received response for id=${id}`);
                    ws.off('message', onMessage);
                    if (res.error) {
                        logDebug(`evaluateScript: execution error: ${res.error.message}`);
                        reject(new Error(res.error.message));
                    } else {
                        const val = res.result && res.result.result ? res.result.result.value : (res.result ? res.result.value : undefined);
                        logDebug(`evaluateScript: execution success, returned type=${typeof val}`);
                        resolve(val);
                    }
                }
            } catch (e) {
                logDebug(`evaluateScript: parse/processing message error: ${e.message}`);
            }
        };
        ws.on('message', onMessage);
        ws.send(JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true }
        }));
    });
}

    async cdpClick(ws, x, y) {
    const send = (method, params) => new Promise(r => {
        const id = Math.floor(Math.random() * 1000000);
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(r, 30);
    });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

    async ensureSidebarOpen(ws) {
    const checkPanelScript = `!!document.querySelector('.antigravity-agent-side-panel')`;
    try {
        const panelExists = await this.evaluateScript(ws, checkPanelScript);
        if (panelExists) {
            return true;
        }
    } catch (e) {
        // Ignore error and try to open anyway
    }

    console.log('Chat sidebar is closed. Attempting to click toggle button...');

    // Find the toggle button coordinates (Toggle Agent / Toggle Assistant / Layout Sidebar Right)
    const findToggleBtnScript = `(() => {
            const btn = document.querySelector('[aria-label*="Toggle Agent"], [aria-label*="Toggle Assistant"], .codicon-layout-sidebar-right, [aria-label*="sidebar-right"]');
            if (btn) {
                const rect = btn.getBoundingClientRect();
                return { found: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
            }
            return { found: false };
        })()`;

    try {
        const toggleBtn = await this.evaluateScript(ws, findToggleBtnScript);
        if (toggleBtn && toggleBtn.found) {
            await this.cdpClick(ws, toggleBtn.x, toggleBtn.y);
            console.log('Clicked toggle button, waiting for sidebar...');

            // Wait up to 3 seconds for the panel to appear
            const start = Date.now();
            while (Date.now() - start < 3000) {
                const panelExists = await this.evaluateScript(ws, checkPanelScript);
                if (panelExists) {
                    console.log('Chat sidebar opened successfully via click.');
                    return true;
                }
                await new Promise(r => setTimeout(r, 200));
            }
        }
    } catch (e) {
        console.error('Failed to click toggle button:', e);
    }

    // Fallback: Try keyboard shortcuts Ctrl+Alt+J and Ctrl+Alt+B
    console.log('Click failed or button not found. Trying keyboard shortcuts Ctrl+Alt+J and Ctrl+Alt+B...');

    const sendKey = (type, key, code, windowsVirtualKeyCode, modifiers) => new Promise(r => {
        const id = Math.floor(Math.random() * 1000000);
        ws.send(JSON.stringify({
            id,
            method: 'Input.dispatchKeyEvent',
            params: { type, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers }
        }));
        setTimeout(r, 30);
    });

    const sendToggleJ = async () => {
        await sendKey('keyDown', 'Control', 'ControlLeft', 17, 2);
        await sendKey('keyDown', 'Alt', 'AltLeft', 18, 3);
        await sendKey('keyDown', 'j', 'KeyJ', 74, 3);
        await sendKey('keyUp', 'j', 'KeyJ', 74, 3);
        await sendKey('keyUp', 'Alt', 'AltLeft', 18, 2);
        await sendKey('keyUp', 'Control', 'ControlLeft', 17, 0);
    };

    const sendToggleB = async () => {
        await sendKey('keyDown', 'Control', 'ControlLeft', 17, 2);
        await sendKey('keyDown', 'Alt', 'AltLeft', 18, 3);
        await sendKey('keyDown', 'b', 'KeyB', 66, 3);
        await sendKey('keyUp', 'b', 'KeyB', 66, 3);
        await sendKey('keyUp', 'Alt', 'AltLeft', 18, 2);
        await sendKey('keyUp', 'Control', 'ControlLeft', 17, 0);
    };

    // Try J
    await sendToggleJ();
    await new Promise(r => setTimeout(r, 500));
    let panelExists = await this.evaluateScript(ws, checkPanelScript);
    if (panelExists) return true;

    // Try B
    await sendToggleB();
    await new Promise(r => setTimeout(r, 500));
    panelExists = await this.evaluateScript(ws, checkPanelScript);
    if (panelExists) return true;

    // Wait up to 2 seconds more
    const start = Date.now();
    while (Date.now() - start < 2000) {
        panelExists = await this.evaluateScript(ws, checkPanelScript);
        if (panelExists) {
            return true;
        }
        await new Promise(r => setTimeout(r, 200));
    }

    console.warn('Failed to open chat sidebar using both click and shortcuts.');
    return false;
}

    async resolveQuickPickDialog(ws) {
    const script = `(() => {
            const isVisible = (el) => {
                if (!el || !(el instanceof HTMLElement)) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };
            
            const widgets = Array.from(document.querySelectorAll('.quick-input-widget, [class*="quick-input-widget"]'));
            const visibleWidget = widgets.find(isVisible);
            if (!visibleWidget) return { found: false };
            
            const inputEl = visibleWidget.querySelector('.quick-input-filter input');
            const placeholder = ((inputEl ? inputEl.getAttribute('placeholder') : '') || '').toLowerCase();
            const widgetText = (visibleWidget.textContent || '').toLowerCase();
            
            const isWindowDialog = placeholder.includes('where to open') || placeholder.includes('open the conversation') || widgetText.includes('where to open');
            const isWorkspaceDialog = placeholder.includes('workspace') || placeholder.includes('select workspace') || widgetText.includes('select workspace') || widgetText.includes('workspace to open');
            
            if (!isWindowDialog && !isWorkspaceDialog) {
                return { found: true, type: 'unknown' };
            }
            
            const rows = Array.from(visibleWidget.querySelectorAll('.monaco-list-row, [role="option"], [role="button"]'));
            const visibleRows = rows.filter(isVisible);
            
            if (isWindowDialog) {
                for (const row of visibleRows) {
                    const rowText = (row.textContent || '').toLowerCase();
                    if (rowText.includes('current window') || rowText.includes('current workspace')) {
                        const rect = row.getBoundingClientRect();
                        return {
                            found: true,
                            type: 'window',
                            x: Math.round(rect.left + rect.width / 2),
                            y: Math.round(rect.top + rect.height / 2)
                        };
                    }
                }
            }
            
            if (isWorkspaceDialog) {
                for (const row of visibleRows) {
                    const rowText = (row.textContent || '').toLowerCase();
                    if (rowText.includes('desktop') || rowText.includes('remoat')) {
                        const rect = row.getBoundingClientRect();
                        return {
                            found: true,
                            type: 'workspace',
                            x: Math.round(rect.left + rect.width / 2),
                            y: Math.round(rect.top + rect.height / 2)
                        };
                    }
                }
                for (const row of visibleRows) {
                    if (row.classList.contains('focused') || row.getAttribute('aria-selected') === 'true') {
                        const rect = row.getBoundingClientRect();
                        return {
                            found: true,
                            type: 'workspace',
                            x: Math.round(rect.left + rect.width / 2),
                            y: Math.round(rect.top + rect.height / 2)
                        };
                    }
                }
                const optionsOnly = visibleRows.filter(r => !r.classList.contains('monaco-button'));
                if (optionsOnly.length > 0) {
                    const rect = optionsOnly[0].getBoundingClientRect();
                    return {
                        found: true,
                        type: 'workspace',
                        x: Math.round(rect.left + rect.width / 2),
                        y: Math.round(rect.top + rect.height / 2)
                    };
                }
            }
            
            return { found: true, type: 'error' };
        })()`;

    const maxWaitMs = 3000;
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
        try {
            const val = await this.evaluateScript(ws, script);
            if (val && val.found && typeof val.x === 'number' && typeof val.y === 'number') {
                console.log(`Resolving QuickPick dialog at x=${val.x}, y=${val.y}`);
                await this.cdpClick(ws, val.x, val.y);
                await new Promise(r => setTimeout(r, 500));
            } else if (val && val.found && val.type === 'error') {
                console.log('QuickPick found but no clickable coordinates. Simulating Enter.');
                await this.evaluateScript(ws, `(() => {
                        const input = document.querySelector('.quick-input-filter input');
                        if (input) {
                            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                            return true;
                        }
                        return false;
                    })()`);
                await new Promise(r => setTimeout(r, 500));
            }
        } catch (e) {
            // ignore
        }
        await new Promise(r => setTimeout(r, 200));
    }
}

    async getCurrentChatTitle(webviewId) {
    logDebug(`getCurrentChatTitle: started with webviewId=${webviewId}`);
    const WebSocket = require('ws');
    try {
        const target = await this.discoverCdpTarget(webviewId);
        logDebug(`getCurrentChatTitle: target discovered, url=${target.webSocketDebuggerUrl}`);
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        return new Promise((resolve) => {
            ws.on('open', async () => {
                logDebug(`getCurrentChatTitle: ws open, evaluating script...`);
                try {
                    const script = `(() => {
                            const panel = document.querySelector('.antigravity-agent-side-panel');
                            if (!panel) return '';
                            const header = panel.querySelector('div[class*="border-b"]');
                            if (!header) return '';
                            const titleEl = header.querySelector('div[class*="text-ellipsis"]');
                            return titleEl ? (titleEl.textContent || '').trim() : '';
                        })()`;
                    const title = await this.evaluateScript(ws, script);
                    logDebug(`getCurrentChatTitle: script evaluated, title="${title}"`);
                    resolve(title || '');
                } catch (e) {
                    logDebug(`getCurrentChatTitle: evaluate error: ${e.message}`);
                    resolve('');
                } finally {
                    ws.close();
                }
            });
            ws.on('error', (err) => {
                logDebug(`getCurrentChatTitle: ws error: ${err ? err.message : 'unknown'}`);
                resolve('');
            });
        });
    } catch (e) {
        logDebug(`getCurrentChatTitle: general error: ${e.message}`);
        return '';
    }
}

    async activateChatSession(uuid, title, webviewId) {
    const WebSocket = require('ws');
    const lang = getActiveLanguage();
    try {
        // Get the latest title and genericTitle from the database dynamically using UUID
        const chatItem = await new Promise((resolve) => {
            this.runBackend(['list', uuid], (success, data) => {
                if (success) {
                    try {
                        const list = JSON.parse(data);
                        const item = list.find(it => it.uuid.toLowerCase() === uuid.toLowerCase());
                        if (item) {
                            resolve(item);
                            return;
                        }
                    } catch (e) { }
                }
                resolve({ title: title, displayTitle: title, dbTitle: title, genericTitle: '' }); // fallback
            });
        });

        const target = await this.discoverCdpTarget(webviewId);
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        ws.on('open', async () => {
            try {
                // Ensure the side chat panel is open first
                const ok = await this.ensureSidebarOpen(ws);
                if (!ok) {
                    throw new Error(getTranslation('errSidebarOpen', lang));
                }

                // Step 1: Open Past Conversations / History
                const findHistoryBtnScript = `(() => {
                        const isVisible = (el) => { if (!el) return false; const rect = el.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) return false; const style = window.getComputedStyle(el); return style.display !== 'none' && style.visibility !== 'hidden'; };
                        const getRect = (el) => {
                            const rect = el.getBoundingClientRect();
                            return { found: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
                        };

                        // Strategy 1 (primary): data-past-conversations-toggle attribute
                        const toggle = document.querySelector('[data-past-conversations-toggle]');
                        if (toggle && isVisible(toggle)) return getRect(toggle);

                        // Strategy 2: data-tooltip-id containing "history"
                        const tooltipEls = Array.from(document.querySelectorAll('[data-tooltip-id]'));
                        for (const el of tooltipEls) {
                            if (!isVisible(el)) continue;
                            const tid = (el.getAttribute('data-tooltip-id') || '').toLowerCase();
                            if (tid.includes('history') || tid.includes('past-conversations')) {
                                    return getRect(el);
                            }
                        }

                        // Strategy 3: SVG with lucide-history class
                        const icons = Array.from(document.querySelectorAll('svg.lucide-history, svg[class*="lucide-history"]'));
                        for (const icon of icons) {
                            const parent = icon.closest('a, button, [role="button"], div[class*="cursor-pointer"]');
                            const target = parent instanceof HTMLElement && isVisible(parent) ? parent : icon;
                            if (isVisible(target)) return getRect(target);
                        }

                        return { found: false, x: 0, y: 0 };
                    })()`;

                const historyBtn = await this.evaluateScript(ws, findHistoryBtnScript);
                if (!historyBtn || !historyBtn.found) {
                    throw new Error(getTranslation('errHistoryBtn', lang));
                }

                await this.cdpClick(ws, historyBtn.x, historyBtn.y);
                logDebug(`activateChatSession: Clicked history button via CDP at x=${historyBtn.x}, y=${historyBtn.y}`);

                // Helper to wait for Quick Pick or Jetski dialog to become visible
                const waitForQuickPick = async (maxMs = 12000) => {
                    const start = Date.now();
                    while (Date.now() - start < maxMs) {
                        const isOpen = await this.evaluateScript(ws, `(() => {
                            const widgets = Array.from(document.querySelectorAll('.quick-input-widget, [class*="quick-input-widget"]'));
                            const activeWidget = widgets.find(w => window.getComputedStyle(w).display !== 'none');
                            if (activeWidget) return true;
                            
                            const jsp = document.querySelector('.jetski-fast-pick');
                            return !!jsp && window.getComputedStyle(jsp).display !== 'none';
                        })()`);
                        if (isOpen) return true;
                        await new Promise(r => setTimeout(r, 200));
                    }
                    return false;
                };

                // Wait for any dialog to open
                const qpOpened = await waitForQuickPick(12000);
                if (!qpOpened) {
                    throw new Error(getTranslation('errQuickPick', lang));
                }
                logDebug(`activateChatSession: Quick Pick/Jetski opened`);

                // Check and resolve intermediate workspace dialog
                const checkWorkspaceScript = `(() => {
                    const widgets = Array.from(document.querySelectorAll('.quick-input-widget, [class*="quick-input-widget"]'));
                    const qp = widgets.find(w => window.getComputedStyle(w).display !== 'none');
                    if (!qp) return { isWorkspace: false };
                    const text = (qp.textContent || '').toLowerCase();
                    const input = qp.querySelector('.quick-input-filter input');
                    const ph = ((input ? input.getAttribute('placeholder') : '') || '').toLowerCase();
                    const isWorkspace = ph.includes('where to open') || text.includes('where to open') || text.includes('open in current window');
                    return { isWorkspace, hasInput: !!input };
                })()`;

                let wsCheck = await this.evaluateScript(ws, checkWorkspaceScript);
                logDebug(`activateChatSession: Workspace check result: ${JSON.stringify(wsCheck)}`);
                if (wsCheck && wsCheck.isWorkspace && wsCheck.hasInput) {
                    logDebug(`activateChatSession: Workspace dialog detected. Pressing Enter to select current window.`);
                    await this.evaluateScript(ws, `(() => {
                        const widgets = Array.from(document.querySelectorAll('.quick-input-widget, [class*="quick-input-widget"]'));
                        const qp = widgets.find(w => window.getComputedStyle(w).display !== 'none');
                        const input = qp ? qp.querySelector('.quick-input-filter input') : null;
                        if (input) {
                            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                            input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                            return true;
                        }
                        return false;
                    })()`);
                    
                    // Wait for transition to history Quick Pick
                    logDebug(`activateChatSession: Waiting for history Quick Pick after workspace resolution...`);
                    await new Promise(r => setTimeout(r, 1500));
                    const qpOpened2 = await waitForQuickPick(12000);
                    if (!qpOpened2) {
                        logDebug(`activateChatSession: Quick Pick closed or window is reloading`);
                        return;
                    }
                }

                // Click "Show more..." button if present in Jetski dialog to load all history items into the DOM
                const clickedShowMore = await this.evaluateScript(ws, `(() => {
                    const jsp = document.querySelector('.jetski-fast-pick');
                    if (!jsp) return false;
                    const divs = Array.from(jsp.querySelectorAll('div.cursor-pointer'));
                    const showMoreBtn = divs.find(d => {
                        const txt = (d.textContent || '');
                        return txt.includes('Show ') && txt.includes(' more');
                    });
                    if (showMoreBtn) {
                        showMoreBtn.click();
                        return true;
                    }
                    return false;
                })()`);
                if (clickedShowMore) {
                    logDebug(`activateChatSession: Clicked "Show more" button in Jetski dialog, waiting 400ms`);
                    await new Promise(r => setTimeout(r, 400));
                }

                // Now we are in the real history dialog (jetski or quick-input). Focus the input first.
                logDebug(`activateChatSession: Focusing history input`);
                await this.evaluateScript(ws, `(() => {
                    const getActiveQP = () => {
                        const widgets = Array.from(document.querySelectorAll('.quick-input-widget, [class*="quick-input-widget"]'));
                        const activeWidget = widgets.find(w => window.getComputedStyle(w).display !== 'none');
                        if (activeWidget) return { type: 'quick-input', element: activeWidget };
                        
                        const jsp = document.querySelector('.jetski-fast-pick');
                        if (jsp && window.getComputedStyle(jsp).display !== 'none') return { type: 'jetski', element: jsp };
                        return null;
                    };
                    const active = getActiveQP();
                    if (!active) return false;
                    const input = active.type === 'quick-input' ? active.element.querySelector('.quick-input-filter input') : active.element.querySelector('input');
                    if (input) {
                        input.focus();
                        input.select();
                        return true;
                    }
                    return false;
                })()`);

                // Send CDP command to insert text
                const sendCdp = (method, params) => new Promise((resolve, reject) => {
                    const id = Math.floor(Math.random() * 1000000);
                    const onMessage = (data) => {
                        try {
                            const res = JSON.parse(data);
                            if (res.id === id) {
                                ws.off('message', onMessage);
                                if (res.error) reject(new Error(res.error.message));
                                else resolve(res.result || {});
                            }
                        } catch (e) {}
                    };
                    ws.on('message', onMessage);
                    ws.send(JSON.stringify({ id, method, params }));
                });

                const generic = chatItem.genericTitle || chatItem.dbTitle || '';
                const display = chatItem.displayTitle || chatItem.title || '';

                logDebug(`activateChatSession: genericTitle="${generic}", displayTitle="${display}"`);

                const checkResultsScript = `(() => {
                    const getActiveQP = () => {
                        const widgets = Array.from(document.querySelectorAll('.quick-input-widget, [class*="quick-input-widget"]'));
                        const activeWidget = widgets.find(w => window.getComputedStyle(w).display !== 'none');
                        if (activeWidget) return { type: 'quick-input', element: activeWidget };
                        
                        const jsp = document.querySelector('.jetski-fast-pick');
                        if (jsp && window.getComputedStyle(jsp).display !== 'none') return { type: 'jetski', element: jsp };
                        return null;
                    };
                    const active = getActiveQP();
                    if (!active) return { success: false, reason: 'no_active_qp' };
                    
                    // Check if a visible element with "no results" text exists
                    const noResultsEl = Array.from(active.element.querySelectorAll('*')).find(el => {
                        const txt = (el.textContent || '').toLowerCase();
                        if (txt.includes('no results') || txt.includes('нет результатов') || txt.includes('no items found') || txt.includes('нет подходящих') || txt.includes('no matches') || txt.includes('не найдено')) {
                            const style = window.getComputedStyle(el);
                            const rect = el.getBoundingClientRect();
                            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                        }
                        return false;
                    });
                    if (noResultsEl) {
                        return { success: false, reason: 'no_results_text_visible', text: noResultsEl.textContent };
                    }
                    
                    const rows = active.type === 'quick-input'
                        ? Array.from(active.element.querySelectorAll('.monaco-list-row, [role="option"]')).filter(r => {
                            const rect = r.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0;
                          })
                        : Array.from(active.element.querySelectorAll('div.cursor-pointer')).filter(r => {
                            const t = r.textContent || '';
                            if (t.includes('Show ') && t.includes(' more')) return false;
                            const rect = r.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0;
                          });
                          
                    return { success: rows.length > 0, count: rows.length };
                })()`;

                let matched = false;
                if (generic) {
                    logDebug(`activateChatSession: Typing generic title: "${generic}"`);
                    await sendCdp('Input.insertText', { text: generic });
                    
                    // Wait for Monaco to filter the list asynchronously (800ms)
                    await new Promise(r => setTimeout(r, 800));

                    // Verify search results
                    const searchRes = await this.evaluateScript(ws, checkResultsScript);
                    logDebug(`activateChatSession: Generic search filter check: ${JSON.stringify(searchRes)}`);
                    
                    if (searchRes && searchRes.success) {
                        logDebug(`activateChatSession: Generic title matched. Pressing Enter to open.`);
                        await this.evaluateScript(ws, `(() => {
                            const getActiveQP = () => {
                                const widgets = Array.from(document.querySelectorAll('.quick-input-widget, [class*="quick-input-widget"]'));
                                const activeWidget = widgets.find(w => window.getComputedStyle(w).display !== 'none');
                                if (activeWidget) return { type: 'quick-input', element: activeWidget };
                                
                                const jsp = document.querySelector('.jetski-fast-pick');
                                if (jsp && window.getComputedStyle(jsp).display !== 'none') return { type: 'jetski', element: jsp };
                                return null;
                            };
                            const active = getActiveQP();
                            if (!active) return false;
                            const input = active.type === 'quick-input' ? active.element.querySelector('.quick-input-filter input') : active.element.querySelector('input');
                            if (input) {
                                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                                input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                                input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                                return true;
                            }
                            return false;
                        })()`);
                        matched = true;
                        vscode.window.showInformationMessage(getTranslation('infoOpenedTitle', lang).replace('{title}', generic));
                    } else {
                        logDebug(`activateChatSession: Generic title did not match. Clearing input.`);
                        // Clear input
                        await this.evaluateScript(ws, `(() => {
                            const getActiveQP = () => {
                                const widgets = Array.from(document.querySelectorAll('.quick-input-widget, [class*="quick-input-widget"]'));
                                const activeWidget = widgets.find(w => window.getComputedStyle(w).display !== 'none');
                                if (activeWidget) return { type: 'quick-input', element: activeWidget };
                                
                                const jsp = document.querySelector('.jetski-fast-pick');
                                if (jsp && window.getComputedStyle(jsp).display !== 'none') return { type: 'jetski', element: jsp };
                                return null;
                            };
                            const active = getActiveQP();
                            if (!active) return false;
                            const input = active.type === 'quick-input' ? active.element.querySelector('.quick-input-filter input') : active.element.querySelector('input');
                            if (input) {
                                input.value = '';
                                input.dispatchEvent(new Event('input', { bubbles: true }));
                                input.dispatchEvent(new Event('change', { bubbles: true }));
                                return true;
                            }
                            return false;
                        })()`);
                        await new Promise(r => setTimeout(r, 200));
                    }
                }

                if (!matched) {
                    logDebug(`activateChatSession: Typing fallback display title: "${display}"`);
                    await sendCdp('Input.insertText', { text: display });
                    
                    // Wait for Monaco to filter the list asynchronously (800ms)
                    await new Promise(r => setTimeout(r, 800));
                    
                    const searchRes = await this.evaluateScript(ws, checkResultsScript);
                    logDebug(`activateChatSession: Fallback search filter check: ${JSON.stringify(searchRes)}`);
                    
                    if (searchRes && searchRes.success) {
                        logDebug(`activateChatSession: Fallback title matched. Pressing Enter to open.`);
                        await this.evaluateScript(ws, `(() => {
                            const getActiveQP = () => {
                                const widgets = Array.from(document.querySelectorAll('.quick-input-widget, [class*="quick-input-widget"]'));
                                const activeWidget = widgets.find(w => window.getComputedStyle(w).display !== 'none');
                                if (activeWidget) return { type: 'quick-input', element: activeWidget };
                                
                                const jsp = document.querySelector('.jetski-fast-pick');
                                if (jsp && window.getComputedStyle(jsp).display !== 'none') return { type: 'jetski', element: jsp };
                                return null;
                            };
                            const active = getActiveQP();
                            if (!active) return false;
                            const input = active.type === 'quick-input' ? active.element.querySelector('.quick-input-filter input') : active.element.querySelector('input');
                            if (input) {
                                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                                input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                                input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                                return true;
                            }
                            return false;
                        })()`);
                        vscode.window.showInformationMessage(getTranslation('infoOpenedTitleFallback', lang).replace('{title}', display));
                    } else {
                        logDebug(`activateChatSession: Dialogue not found in index. Asking user to reload window.`);
                        const reloadBtn = getTranslation('reload', lang);
                        vscode.window.showWarningMessage(
                            getTranslation('warnNotFound', lang).replace('{title}', display),
                            reloadBtn
                        ).then(selection => {
                            if (selection === reloadBtn) {
                                vscode.commands.executeCommand('workbench.action.reloadWindow');
                            }
                        });
                    }
                }
            } catch (e) {
                logDebug(`activateChatSession: Error: ${e.message}`);
                vscode.window.showErrorMessage(getTranslation('errGeneral', lang) + e.message);
            } finally {
                ws.close();
            }
        });
        ws.on('error', (err) => {
            vscode.window.showErrorMessage('Не удалось подключиться к CDP: ' + err.message);
        });
    } catch (err) {
        vscode.window.showErrorMessage('Ошибка: ' + err.message);
    }
}
}

function updateStatusBarIcon(statusBarItem) {
    const lang = getActiveLanguage();
    const iconType = vscode.workspace.getConfiguration('antigravity-chat-manager').get('iconType', 'chat');
    const icon = iconType === 'trash' ? '$(trash)' : '$(comment-discussion)';
    statusBarItem.text = `${icon} ${getTranslation('statusBarText', lang)}`;
    statusBarItem.tooltip = getTranslation('statusBarTooltip', lang);
}

function updateManifestIcon(context) {
    const iconType = vscode.workspace.getConfiguration('antigravity-chat-manager').get('iconType', 'chat');
    const icon = iconType === 'trash' ? '$(trash)' : '$(comment-discussion)';
    const manifestPath = path.join(context.extensionPath, 'package.json');
    try {
        if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (manifest.contributes && manifest.contributes.viewsContainers && manifest.contributes.viewsContainers.activitybar) {
                const bar = manifest.contributes.viewsContainers.activitybar[0];
                if (bar.icon !== icon) {
                    bar.icon = icon;
                    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
                    const lang = getActiveLanguage();
                    const msg = getTranslation('configChangedMsg', lang);
                    const btn = getTranslation('configChangedBtn', lang);
                    vscode.window.showInformationMessage(msg, btn).then(sel => {
                        if (sel === btn) {
                            vscode.commands.executeCommand('workbench.action.reloadWindow');
                        }
                    });
                }
            }
        }
    } catch (e) {
        logDebug('updateManifestIcon error: ' + e.message);
    }
}

function deactivate() { }

module.exports = {
    activate,
    deactivate
};

function getAutoLabel(lang) {
    const labels = {
        "en": "Default (Auto)",
        "ru": "По умолчанию (Авто)",
        "zh-cn": "默认 (自动)",
        "zh-tw": "預設 (自動)",
        "zh": "默认 (自动)",
        "ja": "デフォルト (自動)",
        "ko": "기본값 (자동)",
        "de": "Standard (Auto)",
        "fr": "Par défaut (Auto)",
        "es": "Predeterminado (Auto)",
        "pt-br": "Padrão (Auto)",
        "pt": "Padrão (Auto)",
        "it": "Predefinito (Auto)",
        "tr": "Varsayılan (Otomatik)",
        "pl": "Domyślny (Auto)",
        "cs": "Výchozí (Auto)",
        "vi": "Mặc định (Tự động)",
        "ar": "الافتراضي (تلقائي)",
        "id": "Default (Otomatis)"
    };
    const cleanLang = (lang || 'en').toLowerCase();
    if (labels[cleanLang]) return labels[cleanLang];
    const langBase = cleanLang.split('-')[0];
    return labels[langBase] || labels["en"];
}

function getWebviewContent(lang) {
    const isRu = (lang || '').startsWith('ru');
    const t = {
        title: getTranslation('title', lang),
        subtitle: getTranslation('subtitle', lang),
        refresh: getTranslation('refresh', lang),
        settings: getTranslation('settings', lang),
        reminder: getTranslation('reminder', lang),
        reload: getTranslation('reload', lang),
        restoreAll: getTranslation('restoreAll', lang),
        deleteAll: getTranslation('deleteAll', lang),
        statTotal: getTranslation('statTotal', lang),
        statActive: getTranslation('statActive', lang),
        statOrphaned: getTranslation('statOrphaned', lang),
        statSize: getTranslation('statSize', lang),
        searchPlaceholder: getTranslation('searchPlaceholder', lang),
        filterAllProjects: getTranslation('filterAllProjects', lang),
        filterAll: getTranslation('filterAll', lang),
        filterActive: getTranslation('filterActive', lang),
        filterOrphaned: getTranslation('filterOrphaned', lang),
        sortNewest: getTranslation('sortNewest', lang),
        sortOldest: getTranslation('sortOldest', lang),
        sortSizeDesc: getTranslation('sortSizeDesc', lang),
        sortSizeAsc: getTranslation('sortSizeAsc', lang),
        sortNameAsc: getTranslation('sortNameAsc', lang),
        loading: getTranslation('loading', lang),
        empty: getTranslation('empty', lang),
        modalTitle: getTranslation('modalTitle', lang),
        modalBodyText1: getTranslation('modalBodyText1', lang),
        modalBodyText2: getTranslation('modalBodyText2', lang),
        modalBodyText3: getTranslation('modalBodyText3', lang),
        modalBodyText4: getTranslation('modalBodyText4', lang),
        modalBodyText5: getTranslation('modalBodyText5', lang),
        modalBodyText6: getTranslation('modalBodyText6', lang),
        cancel: getTranslation('cancel', lang),
        deleteForever: getTranslation('deleteForever', lang),
        
        // JS strings
        alertNoRestore: getTranslation('alertNoRestore', lang),
        confirmRestoreAll: getTranslation('confirmRestoreAll', lang),
        confirmRestoreAllSuffix: getTranslation('confirmRestoreAllSuffix', lang),
        alertNoDelete: getTranslation('alertNoDelete', lang),
        confirmDeleteAll: getTranslation('confirmDeleteAll', lang),
        confirmDeleteAllSuffix: getTranslation('confirmDeleteAllSuffix', lang),
        
        // Card strings
        cardCurrent: getTranslation('cardCurrent', lang),
        cardActive: getTranslation('cardActive', lang),
        cardOrphaned: getTranslation('cardOrphaned', lang),
        cardOpenFolder: getTranslation('cardOpenFolder', lang),
        cardOpenInIde: getTranslation('cardOpenInIde', lang),
        cardDeleteForever: getTranslation('cardDeleteForever', lang),
        cardRestoreToIde: getTranslation('cardRestoreToIde', lang),
        cardProject: getTranslation('cardProject', lang),
        cardProjectClick: getTranslation('cardProjectClick', lang),
        cardUnknownLocation: getTranslation('cardUnknownLocation', lang),
        cardUnknown: getTranslation('cardUnknown', lang),
        cardNameInIde: getTranslation('cardNameInIde', lang),
        cardNameInIdeUntilReload: getTranslation('cardNameInIdeUntilReload', lang),
        cardNameInIdeBeforeReload: getTranslation('cardNameInIdeBeforeReload', lang),
        cardNameInIdeUntilReload2: getTranslation('cardNameInIdeUntilReload2', lang),
        cardCreated: getTranslation('cardCreated', lang),
        cardFilesOnDisk: getTranslation('cardFilesOnDisk', lang),
        cardFilesTitle: getTranslation('cardFilesTitle', lang),
        cardVolumeTitle: getTranslation('cardVolumeTitle', lang),
        cardCopyTitle: getTranslation('cardCopyTitle', lang),
        cardCopyUuidTitle: getTranslation('cardCopyUuidTitle', lang),
        cardSearchUuidTitle: getTranslation('cardSearchUuidTitle', lang),
        cardCopyTechnicalTitle: getTranslation('cardCopyTechnicalTitle', lang),
        cardCopyUuidBtnTitle: getTranslation('cardCopyUuidBtnTitle', lang),
        cardEditNote: getTranslation('cardEditNote', lang),
        cardNote: getTranslation('cardNote', lang),
        cardAddNote: getTranslation('cardAddNote', lang),
        cardCreatedTitle: getTranslation('cardCreatedTitle', lang),
        layoutDetailedTitle: getTranslation('layoutDetailedTitle', lang),
        layoutCompactTitle: getTranslation('layoutCompactTitle', lang)
    };

    const languages = [
        { code: 'auto', label: getAutoLabel(lang) },
        { code: 'en', label: 'English' },
        { code: 'ru', label: 'Русский' },
        { code: 'zh-cn', label: '简体中文' },
        { code: 'zh-tw', label: '繁體中文' },
        { code: 'ja', label: '日本語' },
        { code: 'ko', label: '한국어' },
        { code: 'de', label: 'Deutsch' },
        { code: 'fr', label: 'Français' },
        { code: 'es', label: 'Español' },
        { code: 'pt-br', label: 'Português (Brasil)' },
        { code: 'it', label: 'Italiano' },
        { code: 'tr', label: 'Türkçe' },
        { code: 'pl', label: 'Polski' },
        { code: 'cs', label: 'Čeština' },
        { code: 'vi', label: 'Tiếng Việt' },
        { code: 'ar', label: 'العربية' },
        { code: 'id', label: 'Bahasa Indonesia' }
    ];

    const configLang = vscode.workspace.getConfiguration('antigravity-chat-manager').get('language', 'auto');
    let langOptionsHtml = '';
    languages.forEach(l => {
        const selected = l.code === configLang ? ' selected' : '';
        langOptionsHtml += `<option value="${l.code}"${selected}>${l.label}</option>`;
    });

    let html = `<!DOCTYPE html>
<html lang="${isRu ? 'ru' : 'en'}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{title}}</title>
    <style>
        :root {
            --bg-color: #0e0e11;
            --panel-bg: rgba(22, 22, 29, 0.7);
            --border-color: rgba(255, 255, 255, 0.08);
            --text-color: #e2e8f0;
            --text-muted: #94a3b8;
            --primary-color: #3b82f6;
            --primary-hover: #2563eb;
            --success-color: #10b981;
            --warning-color: #f59e0b;
            --danger-color: #ef4444;
            --danger-hover: #dc2626;
            --glass-blur: 12px;
        }

        body {
            background-color: var(--bg-color);
            color: var(--text-color);
            font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            margin: 0;
            padding: 16px;
            overflow-y: auto;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        /* Glassmorphic header */
        header {
            background: var(--panel-bg);
            backdrop-filter: blur(var(--glass-blur));
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            box-shadow: 0 4px 20px 0 rgba(0, 0, 0, 0.2);
        }

        .header-left h1 {
            margin: 0 0 4px 0;
            font-size: 18px;
            font-weight: 600;
            background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .header-left p {
            margin: 0;
            color: var(--text-muted);
            font-size: 12px;
        }

        .header-actions {
            display: flex;
            gap: 12px;
        }

        /* Metrics layout */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 12px;
            margin-bottom: 16px;
        }

        .stat-card {
            background: var(--panel-bg);
            border: 1px solid var(--border-color);
            border-radius: 10px;
            padding: 14px;
            display: flex;
            flex-direction: column;
            box-shadow: 0 4px 12px 0 rgba(0, 0, 0, 0.1);
        }

        .stat-card .label {
            color: var(--text-muted);
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 4px;
        }

        .stat-card .value {
            font-size: 20px;
            font-weight: 700;
        }

        .stat-card.wasted .value {
            color: var(--warning-color);
        }

        /* Controls / Filtering */
        .controls-bar {
            background: var(--panel-bg);
            border: 1px solid var(--border-color);
            border-radius: 10px;
            padding: 12px;
            margin-bottom: 16px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            align-items: stretch;
        }

        .controls-row {
            display: flex;
            flex-wrap: wrap;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
            width: 100%;
        }

        .search-box {
            position: relative;
            flex-grow: 1;
            max-width: 300px;
        }

        .search-box input {
            width: 100%;
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 8px 12px;
            padding-right: 32px;
            color: var(--text-color);
            box-sizing: border-box;
            outline: none;
            transition: border-color 0.2s;
            font-size: 13px;
        }

        .search-box input:focus {
            border-color: var(--primary-color);
        }

        .search-clear-btn {
            position: absolute;
            right: 8px;
            top: 50%;
            transform: translateY(-50%);
            background: none;
            border: none;
            color: var(--text-muted);
            cursor: pointer;
            padding: 4px;
            display: none;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            transition: background-color 0.15s, color 0.15s;
        }

        .search-clear-btn:hover {
            background-color: rgba(255, 255, 255, 0.08);
            color: var(--text-color);
        }

        .filter-badges {
            display: flex;
            gap: 6px;
        }

        .filter-btn {
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid var(--border-color);
            color: var(--text-muted);
            padding: 6px 12px;
            border-radius: 16px;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.2s;
        }

        .filter-btn:hover {
            background: rgba(255, 255, 255, 0.08);
            color: var(--text-color);
        }

        .filter-btn.active {
            background: var(--primary-color);
            color: white;
            border-color: var(--primary-color);
        }

        .sort-select {
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border-color);
            color: var(--text-color);
            padding: 6px 10px;
            border-radius: 6px;
            outline: none;
            cursor: pointer;
            font-size: 12px;
            max-width: 100%;
            transition: border-color 0.2s;
        }

        .sort-select:hover, .sort-select:focus {
            border-color: var(--primary-color);
        }

        .sort-select option {
            background-color: var(--vscode-dropdown-background, #1e1e24);
            color: var(--vscode-dropdown-foreground, var(--text-color));
        }

        /* Dialogue list */
        .chat-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .chat-card {
            background: var(--panel-bg);
            border: 1px solid var(--border-color);
            border-radius: 10px;
            padding: 14px;
            display: grid;
            grid-template-columns: 1fr auto;
            align-items: center;
            gap: 16px;
            transition: border-color 0.2s;
            box-shadow: 0 4px 12px 0 rgba(0, 0, 0, 0.1);
        }

        .chat-card:hover {
            border-color: rgba(255, 255, 255, 0.15);
        }

        .chat-card.current {
            border-left: 3px solid var(--primary-color);
        }

        .chat-info {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .chat-title-row {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .chat-title {
            font-size: 14px;
            font-weight: 600;
            margin: 0;
        }

        .badge {
            font-size: 9px;
            padding: 2px 6px;
            border-radius: 3px;
            font-weight: 600;
            text-transform: uppercase;
        }

        .badge.active {
            background: rgba(16, 185, 129, 0.1);
            color: var(--success-color);
            border: 1px solid rgba(16, 185, 129, 0.2);
        }

        .badge.orphaned {
            background: rgba(245, 158, 11, 0.1);
            color: var(--warning-color);
            border: 1px solid rgba(245, 158, 11, 0.2);
        }

        .badge.current {
            background: rgba(59, 130, 246, 0.1);
            color: var(--primary-color);
            border: 1px solid rgba(59, 130, 246, 0.2);
        }

        .chat-uuid-row {
            display: flex;
            align-items: center;
            gap: 6px;
            font-family: monospace;
            font-size: 11px;
            color: var(--text-muted);
        }

        .copy-btn {
            background: none;
            border: none;
            cursor: pointer;
            color: var(--text-muted);
            padding: 2px;
            display: inline-flex;
            align-items: center;
            border-radius: 3px;
            transition: background-color 0.2s;
        }

        .copy-btn:hover {
            background: rgba(255, 255, 255, 0.08);
            color: var(--text-color);
        }

        .chat-meta-row {
            display: flex;
            flex-wrap: wrap;
            gap: 16px;
            font-size: 12px;
            color: var(--text-muted);
        }

        .meta-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .meta-item svg {
            color: var(--text-muted);
        }

        .chat-note-row {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
            color: #fbbf24;
            background: rgba(251, 191, 36, 0.05);
            border: 1px dashed rgba(251, 191, 36, 0.2);
            border-radius: 6px;
            padding: 4px 8px;
            margin-top: 4px;
            cursor: pointer;
            transition: background 0.15s, border-color 0.15s;
            max-width: 100%;
            width: fit-content;
        }

        .chat-note-row:hover {
            background: rgba(251, 191, 36, 0.1);
            border-color: rgba(251, 191, 36, 0.4);
        }

        .chat-note-row.empty {
            color: var(--text-muted);
            background: rgba(255, 255, 255, 0.02);
            border: 1px dashed var(--border-color);
        }

        .chat-note-row.empty:hover {
            background: rgba(255, 255, 255, 0.05);
            border-color: var(--text-muted);
        }

        .note-inline-input {
            background: rgba(0, 0, 0, 0.5);
            border: 1px solid var(--primary-color);
            border-radius: 4px;
            color: var(--text-color);
            padding: 2px 6px;
            font-size: 11px;
            outline: none;
            width: 250px;
        }

        .chat-actions {
            display: flex;
            gap: 8px;
        }

        /* Buttons */
        .btn {
            background: var(--primary-color);
            color: white;
            border: none;
            border-radius: 4px;
            padding: 6px 12px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: background-color 0.2s;
        }

        .btn:hover {
            background: var(--primary-hover);
        }

        .btn-danger {
            background: var(--danger-color);
        }

        .btn-danger:hover {
            background: var(--danger-hover);
        }

        .btn-outline {
            background: none;
            border: 1px solid var(--border-color);
            color: var(--text-color);
        }

        .btn-outline:hover {
            background: rgba(255, 255, 255, 0.04);
        }

        .btn-danger-outline {
            transition: background-color 0.2s, border-color 0.2s, color 0.2s;
        }

        .btn-danger-outline:hover {
            background-color: var(--danger-color) !important;
            border-color: var(--danger-color) !important;
            color: white !important;
        }

        .btn-vscode-primary {
            background-color: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #ffffff);
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 2px;
            padding: 4px 10px;
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            white-space: nowrap;
            transition: background-color 0.15s;
        }

        .btn-vscode-primary:hover {
            background-color: var(--vscode-button-hoverBackground, #1177bb);
        }

        .btn-success {
            background: var(--success-color);
        }

        .btn-success:hover {
            background: #059669;
        }

        .btn-icon-only {
            padding: 6px;
            border-radius: 4px;
            cursor: pointer;
            border: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: background-color 0.2s;
        }

        .btn-icon-only.btn-open-folder {
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid var(--border-color);
            color: var(--text-muted);
        }

        .btn-icon-only.btn-open-folder:hover {
            background: rgba(255, 255, 255, 0.1);
            border-color: rgba(255, 255, 255, 0.2);
            color: var(--text-color);
        }

        .btn-icon-only.btn-launch {
            background: rgba(59, 130, 246, 0.05);
            border: 1px solid rgba(59, 130, 246, 0.2);
            color: #60a5fa;
        }

        .btn-icon-only.btn-launch:hover {
            background: rgba(59, 130, 246, 0.15);
            border-color: rgba(59, 130, 246, 0.4);
            color: #93c5fd;
        }

        /* Reminder banner */
        .reminder-banner {
            background: rgba(59, 130, 246, 0.06);
            border: 1px solid rgba(59, 130, 246, 0.15);
            border-radius: 10px;
            padding: 10px 14px;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 12px;
            color: #93c5fd;
            font-size: 13px;
        }

        .reminder-banner svg {
            flex-shrink: 0;
            color: #60a5fa;
        }

        /* Confirmation Modal */
        .modal-backdrop {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(4px);
            z-index: 1000;
            justify-content: center;
            align-items: center;
        }

        .modal {
            background: #16161d;
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 20px;
            max-width: 400px;
            width: 90%;
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3);
            display: flex;
            flex-direction: column;
            gap: 14px;
        }

        .modal-title {
            font-size: 16px;
            font-weight: 600;
            margin: 0;
        }

        .modal-body {
            font-size: 13px;
            color: var(--text-muted);
            line-height: 1.5;
        }

        .modal-footer {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
        }

        /* Loading */
        .loading-screen {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 200px;
            gap: 12px;
            font-size: 13px;
            color: var(--text-muted);
        }

        .spinner {
            width: 32px;
            height: 32px;
            border: 3px solid rgba(255, 255, 255, 0.1);
            border-left-color: var(--primary-color);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--text-muted);
            font-size: 13px;
        }

        .empty-state svg {
            margin-bottom: 12px;
            color: rgba(255,255,255,0.06);
        }

        .chat-workspace-row {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 6px;
            font-size: 11px;
            color: var(--text-muted);
            margin-top: 2px;
        }

        .workspace-badge {
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.08);
            color: #c084fc;
            padding: 2px 6px;
            border-radius: 4px;
            font-weight: 550;
            display: inline-flex;
            align-items: center;
            cursor: pointer;
            transition: background 0.2s, border-color 0.2s, color 0.2s;
        }

        .workspace-badge:hover {
            background: rgba(192, 132, 252, 0.15);
            border-color: rgba(192, 132, 252, 0.4);
            color: #d8b4fe;
        }

        .workspace-badge.unknown {
            color: var(--text-muted);
            background: rgba(255, 255, 255, 0.02);
            border-color: rgba(255, 255, 255, 0.04);
            font-style: italic;
            cursor: default;
        }

        .chat-title-container {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .chat-title.btn-open-folder {
            cursor: pointer;
            transition: color 0.15s;
        }

        .chat-title.btn-open-folder:hover {
            color: var(--primary-color);
            text-decoration: underline;
        }

        .chat-dbtitle-row {
            font-size: 11px;
            color: var(--text-muted);
            margin-top: 2px;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .chat-dbtitle-row code {
            background: rgba(255, 255, 255, 0.04);
            padding: 1px 4px;
            border-radius: 3px;
            color: var(--warning-color);
            font-family: monospace;
        }

        .chat-dbtitle-row code.btn-copy {
            cursor: pointer;
            transition: background 0.15s, color 0.15s;
        }

        .chat-dbtitle-row code.btn-copy:hover {
            background: rgba(59, 130, 246, 0.1);
            color: var(--primary-color);
        }

        .chat-uuid-row span.btn-copy {
            cursor: pointer;
            transition: color 0.15s;
        }

        .chat-uuid-row span.btn-copy:hover {
            color: var(--primary-color);
        }

        .hover-copy-btn {
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.15s ease-in-out;
        }

        .chat-title-container:hover .hover-copy-btn,
        .chat-dbtitle-row:hover .hover-copy-btn {
            opacity: 0.6;
            pointer-events: auto;
        }

        .chat-title-container .hover-copy-btn:hover,
        .chat-dbtitle-row .hover-copy-btn:hover {
            opacity: 1;
        }

        /* Compact mode styles */
        .chat-list.compact .chat-card {
            padding: 6px 12px;
            gap: 12px;
        }
        .chat-list.compact .chat-uuid-row {
            display: none !important;
        }
        .chat-list.compact .chat-dbtitle-row {
            display: none !important;
        }
        .chat-list.compact .chat-note-row.empty {
            display: none !important;
        }
        .chat-list.compact .chat-note-row.editing {
            display: flex !important;
        }
        .chat-list.compact .workspace-badge.unknown {
            display: none !important;
        }
        .chat-list.compact .chat-workspace-row {
            margin-top: 0px;
        }
        .chat-list.compact .chat-workspace-row:has(.unknown) {
            display: none !important;
        }
        .chat-list.compact .chat-actions {
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s ease-in-out;
        }
        .chat-list.compact .chat-card:hover .chat-actions {
            opacity: 1;
            pointer-events: auto;
        }
        .chat-list.compact .chat-title {
            font-size: 13px;
        }
        .chat-list.compact .chat-meta-row {
            font-size: 11px;
            gap: 12px;
        }
        .chat-list.compact .chat-info {
            gap: 4px;
        }

        /* Layout Switch Segment Control */
        .layout-switch-group {
            display: inline-flex;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 2px;
            height: 28px;
            box-sizing: border-box;
            gap: 2px;
            align-items: center;
        }
        
        .layout-switch-btn {
            background: none;
            border: none;
            color: var(--text-muted);
            width: 24px;
            height: 22px;
            border-radius: 4px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s ease-in-out;
            padding: 0;
        }
        
        .layout-switch-btn:hover {
            color: var(--text-color);
            background: rgba(255, 255, 255, 0.04);
        }
        
        .layout-switch-btn.active {
            background: rgba(59, 130, 246, 0.15);
            color: #60a5fa;
        }
    </style>
</head>
<body>
    <div class="container" id="app">
        <!-- Header -->
        <header>
            <div class="header-left">
                <h1>{{title}}</h1>
                <p>{{subtitle}}</p>
            </div>
            <div class="header-actions" style="display: flex; gap: 8px; align-items: center;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--text-muted); flex-shrink: 0; margin-right: -4px;" title="Language / Язык">
                    <path d="m5 8 6 6"/>
                    <path d="m4 14 6-6 2-3"/>
                    <path d="M2 5h12"/>
                    <path d="M7 2h1"/>
                    <path d="m22 22-5-10-5 10"/>
                    <path d="M14 18h6"/>
                </svg>
                <select class="sort-select" id="language-select" style="max-width: 120px; font-size: 11px; padding: 4px 8px; height: 28px; line-height: 18px; border-radius: 6px;">
                    ${langOptionsHtml}
                </select>
                <div class="layout-switch-group">
                    <button class="layout-switch-btn" id="btn-layout-detailed" title="{{layoutDetailedTitle}}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                    </button>
                    <button class="layout-switch-btn" id="btn-layout-compact" title="{{layoutCompactTitle}}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                    </button>
                </div>
                <button class="btn btn-outline" id="btn-settings" title="{{settings}}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                </button>
                <button class="btn btn-outline" id="btn-refresh">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                    {{refresh}}
                </button>
            </div>
        </header>

        <!-- Notification Banner -->
        <div class="reminder-banner" style="justify-content: space-between; align-items: center; width: 100%;">
            <div style="display: flex; align-items: center; gap: 12px;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                <div>
                    {{reminder}}
                </div>
            </div>
            <button class="btn-vscode-primary" id="btn-reload-window" style="margin-left: auto;">
                {{reload}}
            </button>
        </div>

        <!-- Bulk Actions Bar -->
        <div style="display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap;">
            <button class="btn btn-outline" id="btn-restore-all" style="font-size: 11px; padding: 6px 12px;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px; display: inline-block; vertical-align: middle;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                {{restoreAll}}
            </button>
            <button class="btn btn-outline btn-danger-outline" id="btn-delete-all" style="font-size: 11px; padding: 6px 12px; border-color: rgba(239, 68, 68, 0.4); color: #f87171; background: rgba(239, 68, 68, 0.05);">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px; display: inline-block; vertical-align: middle;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                {{deleteAll}}
            </button>
        </div>

        <!-- Stats Grid -->
        <div class="stats-grid">
            <div class="stat-card">
                <span class="label">{{statTotal}}</span>
                <span class="value" id="stat-total">-</span>
            </div>
            <div class="stat-card">
                <span class="label">{{statActive}}</span>
                <span class="value" id="stat-active" style="color: var(--success-color);">-</span>
            </div>
            <div class="stat-card">
                <span class="label">{{statOrphaned}}</span>
                <span class="value" id="stat-orphaned" style="color: var(--warning-color);">-</span>
            </div>
            <div class="stat-card wasted">
                <span class="label">{{statSize}}</span>
                <span class="value" id="stat-size">-</span>
            </div>
        </div>

        <!-- Controls -->
        <div class="controls-bar">
            <div class="controls-row">
                <div class="search-box">
                    <input type="text" id="search-input" placeholder="{{searchPlaceholder}}">
                    <button id="search-clear-btn" class="search-clear-btn" title="{{cancel}}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
                <select class="sort-select" id="project-filter" style="max-width: 180px;">
                    <option value="all">{{filterAllProjects}}</option>
                </select>
            </div>
            <div class="controls-row">
                <div class="filter-badges">
                    <button class="filter-btn active" data-filter="all">{{filterAll}}</button>
                    <button class="filter-btn" data-filter="active">{{filterActive}}</button>
                    <button class="filter-btn" data-filter="orphaned">{{filterOrphaned}}</button>
                </div>
                <select class="sort-select" id="sort-select">
                    <option value="date-desc">{{sortNewest}}</option>
                    <option value="date-asc">{{sortOldest}}</option>
                    <option value="size-desc">{{sortSizeDesc}}</option>
                    <option value="size-asc">{{sortSizeAsc}}</option>
                    <option value="name-asc">{{sortNameAsc}}</option>
                </select>
            </div>
        </div>

        <!-- Content -->
        <div id="loading-view" class="loading-screen">
            <div class="spinner"></div>
            <div>{{loading}}</div>
        </div>

        <div id="empty-view" class="empty-state" style="display: none;">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
            <div>{{empty}}</div>
        </div>

        <div id="chat-list-view" class="chat-list" style="display: none;">
            <!-- Rendered dynamically -->
        </div>
    </div>

    <!-- Confirm Modal -->
    <div class="modal-backdrop" id="delete-modal">
        <div class="modal">
            <h3 class="modal-title" style="color: var(--danger-color);">{{modalTitle}}</h3>
            <div class="modal-body">
                {{modalBodyText1}} <strong id="modal-chat-title"></strong>?<br><br>
                {{modalBodyText2}}<br>
                {{modalBodyText3}} <code>brain/</code><br>
                {{modalBodyText4}} <code>conversations/</code><br>
                {{modalBodyText5}} <code>annotations/</code><br><br>
                <span style="color: var(--danger-color); font-weight: 600;">{{modalBodyText6}}</span>
            </div>
            <div class="modal-footer">
                <button class="btn btn-outline" id="btn-cancel-delete">{{cancel}}</button>
                <button class="btn btn-danger" id="btn-confirm-delete">{{deleteForever}}</button>
            </div>
        </div>
    </div>

    <script>
        const t = ${JSON.stringify(t)};
        window.addEventListener('error', function(event) {
            document.body.innerHTML = 
                '<div style="padding: 20px; color: #ef4444; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 8px; font-family: monospace;">' +
                    '<h3 style="margin: 0 0 10px 0;">JS Error inside Webview</h3>' +
                    '<p style="margin: 0 0 10px 0; font-weight: bold;">' + escapeHtml(event.message || '') + '</p>' +
                    '<p style="margin: 0; font-size: 11px; color: #94a3b8; white-space: pre-wrap;">' + escapeHtml(event.error ? event.error.stack || '' : '') + '</p>' +
                '</div>';
        });
        window.addEventListener('unhandledrejection', function(event) {
            var reason = event.reason;
            var msg = reason ? reason.message || String(reason) : 'Unknown reason';
            var stack = reason && reason.stack ? reason.stack : '';
            document.body.innerHTML = 
                '<div style="padding: 20px; color: #ef4444; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 8px; font-family: monospace;">' +
                    '<h3 style="margin: 0 0 10px 0;">Unhandled Promise Rejection</h3>' +
                    '<p style="margin: 0 0 10px 0; font-weight: bold;">' + escapeHtml(msg) + '</p>' +
                    '<p style="margin: 0; font-size: 11px; color: #94a3b8; white-space: pre-wrap;">' + escapeHtml(stack) + '</p>' +
                '</div>';
        });

        const vscode = acquireVsCodeApi();
        const urlParams = new URLSearchParams(window.location.search);
        const webviewId = urlParams.get('id') || '';

        function sendToExtension(data) {
            vscode.postMessage(Object.assign({}, data, { webviewId: webviewId }));
        }

        let conversations = [];
        let currentFilter = 'all';
        let currentSearch = '';
        let currentSort = 'date-desc';
        let chatToDelete = null;
        let currentLayout = localStorage.getItem('layoutMode') || 'detailed';

        // Dom Elements
        const loadingView = document.getElementById('loading-view');
        const emptyView = document.getElementById('empty-view');
        const chatListView = document.getElementById('chat-list-view');
        const searchInput = document.getElementById('search-input');
        const searchClearBtn = document.getElementById('search-clear-btn');
        const sortSelect = document.getElementById('sort-select');
        const deleteModal = document.getElementById('delete-modal');
        
        const statTotal = document.getElementById('stat-total');
        const statActive = document.getElementById('stat-active');
        const statOrphaned = document.getElementById('stat-orphaned');
        const statSize = document.getElementById('stat-size');

        function applyLayout() {
            const listEl = document.getElementById('chat-list-view');
            const btnDetailed = document.getElementById('btn-layout-detailed');
            const btnCompact = document.getElementById('btn-layout-compact');
            
            if (currentLayout === 'compact') {
                listEl.classList.add('compact');
                if (btnCompact) btnCompact.classList.add('active');
                if (btnDetailed) btnDetailed.classList.remove('active');
            } else {
                listEl.classList.remove('compact');
                if (btnDetailed) btnDetailed.classList.add('active');
                if (btnCompact) btnCompact.classList.remove('active');
            }
        }

        // Apply initial layout
        applyLayout();

        // Initial fetch
        sendToExtension({ command: 'list' });

        // Event Listeners
        document.getElementById('btn-reload-window').addEventListener('click', () => {
            sendToExtension({ command: 'reloadWindow' });
        });

        document.getElementById('btn-refresh').addEventListener('click', () => {
            showLoading();
            sendToExtension({ command: 'list' });
        });

        document.getElementById('btn-settings').addEventListener('click', () => {
            sendToExtension({ command: 'openSettings' });
        });

        document.getElementById('btn-layout-detailed').addEventListener('click', () => {
            currentLayout = 'detailed';
            localStorage.setItem('layoutMode', currentLayout);
            applyLayout();
        });

        document.getElementById('btn-layout-compact').addEventListener('click', () => {
            currentLayout = 'compact';
            localStorage.setItem('layoutMode', currentLayout);
            applyLayout();
        });

        document.getElementById('language-select').addEventListener('change', (e) => {
            sendToExtension({ command: 'changeLanguage', language: e.target.value });
        });

        document.getElementById('btn-restore-all').addEventListener('click', () => {
            const count = conversations.filter(c => !c.isActive).length;
            if (count === 0) {
                alert(t.alertNoRestore);
                return;
            }
            if (confirm(t.confirmRestoreAll + count + t.confirmRestoreAllSuffix)) {
                showLoading();
                sendToExtension({ command: 'restoreAllOrphaned' });
            }
        });

        document.getElementById('btn-delete-all').addEventListener('click', () => {
            const count = conversations.filter(c => !c.isActive).length;
            if (count === 0) {
                alert(t.alertNoDelete);
                return;
            }
            if (confirm(t.confirmDeleteAll + count + t.confirmDeleteAllSuffix)) {
                showLoading();
                sendToExtension({ command: 'deleteAllOrphaned' });
            }
        });

        searchInput.addEventListener('input', (e) => {
            currentSearch = e.target.value.toLowerCase();
            if (e.target.value) {
                searchClearBtn.style.display = 'inline-flex';
            } else {
                searchClearBtn.style.display = 'none';
            }
            renderList();
        });

        searchClearBtn.addEventListener('click', () => {
            searchInput.value = '';
            currentSearch = '';
            searchClearBtn.style.display = 'none';
            searchInput.focus();
            renderList();
        });

        sortSelect.addEventListener('change', (e) => {
            currentSort = e.target.value;
            renderList();
        });

        document.getElementById('project-filter').addEventListener('change', () => {
            renderList();
        });

        const filterBtns = document.querySelectorAll('.filter-btn');
        for (let i = 0; i < filterBtns.length; i++) {
            const btn = filterBtns[i];
            btn.addEventListener('click', () => {
                for (let j = 0; j < filterBtns.length; j++) {
                    filterBtns[j].classList.remove('active');
                }
                btn.classList.add('active');
                currentFilter = btn.dataset.filter;
                renderList();
            });
        }

        document.getElementById('btn-cancel-delete').addEventListener('click', () => {
            deleteModal.style.display = 'none';
            chatToDelete = null;
        });

        document.getElementById('btn-confirm-delete').addEventListener('click', () => {
            if (chatToDelete) {
                sendToExtension({ command: 'delete', uuid: chatToDelete });
                deleteModal.style.display = 'none';
                showLoading();
                chatToDelete = null;
            }
        });

        // Message receiver (from Extension host)
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'listData':
                    conversations = message.data;
                    updateStats();
                    renderList();
                    break;
                case 'actionSuccess':
                    sendToExtension({ command: 'list' });
                    break;
            }
        });

        function showLoading() {
            loadingView.style.display = 'flex';
            chatListView.style.display = 'none';
            emptyView.style.display = 'none';
        }

        function updateStats() {
            statTotal.innerText = conversations.length;
            
            const active = conversations.filter(c => c.isActive).length;
            statActive.innerText = active;
            
            const orphaned = conversations.filter(c => !c.isActive).length;
            statOrphaned.innerText = orphaned;
            
            const totalWastedBytes = conversations.filter(c => !c.isActive).reduce((sum, c) => sum + c.size_bytes, 0);
            statSize.innerText = formatSize(totalWastedBytes);

            // Rebuild project filter options
            const projectFilter = document.getElementById('project-filter');
            const projects = new Set();
            conversations.forEach(c => {
                if (c.workspaces) {
                    c.workspaces.forEach(w => projects.add(w));
                }
            });
            const prevVal = projectFilter.value;
            projectFilter.innerHTML = '<option value="all">' + t.filterAllProjects + '</option>';
            
            function getPrettyPath(p) {
                const clean = p.replace(/\\\\/g, '/').replace(/\\/+$/, '');
                const parts = clean.split('/');
                const folderName = parts[parts.length - 1] || p;
                if (parts.length > 1) {
                    let parent = parts.slice(0, -1).join('/');
                    parent = parent.replace(/^[Cc]:\\/[Uu]sers\\/[^\\/]+/, '~');
                    parent = parent.replace(/^\\/[Usersusers]+\\/[^\\/]+/, '~');
                    if (parent.length > 30) {
                        const pParts = parent.split('/');
                        if (pParts.length > 3) {
                            parent = pParts[0] + '/.../' + pParts[pParts.length - 1];
                        }
                    }
                    if (p.includes('\\\\')) {
                        parent = parent.replace(/\\//g, '\\\\');
                    }
                    return folderName + ' (' + parent + ')';
                }
                return folderName;
            }

            Array.from(projects).sort().forEach(p => {
                const opt = document.createElement('option');
                opt.value = p;
                opt.textContent = getPrettyPath(p);
                opt.title = p;
                projectFilter.appendChild(opt);
            });
            if (Array.from(projects).includes(prevVal)) {
                projectFilter.value = prevVal;
            } else {
                projectFilter.value = 'all';
            }
        }

        function formatSize(bytes) {
            if (bytes === 0) return '0 B';
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
        }

        function renderList() {
            const selectedProject = document.getElementById('project-filter').value;
            // Apply filtering
            let filtered = conversations.filter(c => {
                if (currentFilter === 'active' && !c.isActive) return false;
                if (currentFilter === 'orphaned' && c.isActive) return false;
                
                if (selectedProject !== 'all') {
                    if (!c.workspaces || !c.workspaces.includes(selectedProject)) return false;
                }

                if (currentSearch) {
                    const titleMatch = c.title.toLowerCase().indexOf(currentSearch) !== -1;
                    const uuidMatch = c.uuid.toLowerCase().indexOf(currentSearch) !== -1;
                    return titleMatch || uuidMatch;
                }
                return true;
            });

            // Apply sorting
            filtered.sort((a, b) => {
                if (currentSort === 'date-desc') {
                    return b.created_at - a.created_at;
                } else if (currentSort === 'date-asc') {
                    return a.created_at - b.created_at;
                } else if (currentSort === 'size-desc') {
                    return b.size_bytes - a.size_bytes;
                } else if (currentSort === 'size-asc') {
                    return a.size_bytes - b.size_bytes;
                } else if (currentSort === 'name-asc') {
                    return a.title.localeCompare(b.title);
                }
                return 0;
            });

            // UI render
            loadingView.style.display = 'none';
            
            if (filtered.length === 0) {
                emptyView.style.display = 'block';
                chatListView.style.display = 'none';
                return;
            }

            emptyView.style.display = 'none';
            chatListView.style.display = 'flex';
            chatListView.innerHTML = '';

            for (let i = 0; i < filtered.length; i++) {
                const chat = filtered[i];
                const card = document.createElement('div');
                card.className = 'chat-card' + (chat.isCurrent ? ' current' : '');
                
                let badgeHtml = '';
                if (chat.isCurrent) {
                    badgeHtml = '<span class="badge current">' + t.cardCurrent + '</span>';
                } else if (chat.isActive) {
                    badgeHtml = '<span class="badge active">' + t.cardActive + '</span>';
                } else {
                    badgeHtml = '<span class="badge orphaned">' + t.cardOrphaned + '</span>';
                }

                const dateStr = chat.created_at_str ? chat.created_at_str : t.cardUnknown;

                let actionHtml = '';
                // Search button (always present)
                actionHtml = '<button class="btn btn-outline btn-icon-only btn-open-search" data-uuid="' + chat.uuid + '" title="' + t.cardSearchUuidTitle + '">' +
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
                '</button>' +
                // Edit note button (always present)
                '<button class="btn btn-outline btn-icon-only btn-action-note" data-uuid="' + chat.uuid + '" title="' + t.cardEditNote + '">' +
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
                '</button>' +
                // Open folder button (always present)
                '<button class="btn btn-outline btn-icon-only btn-open-folder" data-uuid="' + chat.uuid + '" title="' + t.cardOpenFolder + '">' +
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' +
                '</button>';
                
                if (!chat.isCurrent) {
                    if (chat.isActive) {
                        actionHtml += '<button class="btn btn-outline btn-icon-only btn-launch" data-uuid="' + chat.uuid + '" data-title="' + (chat.title || '').replace(/"/g, '&quot;') + '" title="' + t.cardOpenInIde + '">' +
                            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>' +
                        '</button>';
                        actionHtml += '<button class="btn btn-danger btn-icon-only btn-delete" data-uuid="' + chat.uuid + '" data-title="' + (chat.title || '').replace(/"/g, '&quot;') + '" title="' + t.cardDeleteForever + '">' +
                            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>' +
                        '</button>';
                    } else {
                        actionHtml += '<button class="btn btn-success btn-icon-only btn-restore" data-uuid="' + chat.uuid + '" data-title="' + (chat.title || '').replace(/"/g, '&quot;') + '" title="' + t.cardRestoreToIde + '">' +
                            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
                        '</button>' +
                        '<button class="btn btn-danger btn-icon-only btn-delete" data-uuid="' + chat.uuid + '" data-title="' + (chat.title || '').replace(/"/g, '&quot;') + '" title="' + t.cardDeleteForever + '">' +
                            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>' +
                        '</button>';
                    }
                }

                let workspaceHtml = '';
                if (chat.workspaces && chat.workspaces.length > 0) {
                    const wsItems = chat.workspaces.map(ws => {
                        return '<span class="workspace-badge open-ws-btn" data-path="' + escapeHtml(ws) + '" title="' + escapeHtml(ws) + t.cardProjectClick + '">' +
                            '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px; display: inline-block; vertical-align: middle;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' +
                            escapeHtml(ws) +
                        '</span>';
                    }).join(' ');
                    workspaceHtml = '<div class="chat-workspace-row"><span>' + t.cardProject + ': </span>' + wsItems + '</div>';
                } else {
                    workspaceHtml = '<div class="chat-workspace-row"><span>' + t.cardProject + ': </span><span class="workspace-badge unknown" title="' + t.cardUnknownLocation + '">' + t.cardUnknown + '</span></div>';
                }

                let dbTitleHtml = '';
                if (chat.dbTitle && chat.dbTitle !== chat.displayTitle) {
                    dbTitleHtml = '<div class="chat-dbtitle-row" title="' + t.cardNameInIdeUntilReload + '">' +
                        '<span>' + t.cardNameInIde + ': </span><code class="btn-copy" data-text="' + escapeHtml(chat.dbTitle) + '" data-label="' + t.cardNameInIde + '" title="' + t.cardCopyTitle + '">' + escapeHtml(chat.dbTitle) + '</code>' +
                        '<button class="copy-btn btn-copy hover-copy-btn" data-text="' + escapeHtml(chat.dbTitle) + '" data-label="' + t.cardNameInIde + '" title="' + t.cardCopyTechnicalTitle + '">' +
                            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
                        '</button>' +
                    '</div>';
                } else if (chat.genericTitle && chat.title !== chat.genericTitle) {
                    dbTitleHtml = '<div class="chat-dbtitle-row" title="' + t.cardNameInIdeBeforeReload + '">' +
                        '<span>' + t.cardNameInIdeUntilReload2 + ': </span><code class="btn-copy" data-text="' + escapeHtml(chat.genericTitle) + '" data-label="' + t.cardNameInIde + '" title="' + t.cardCopyTitle + '">' + escapeHtml(chat.genericTitle) + '</code>' +
                        '<button class="copy-btn btn-copy hover-copy-btn" data-text="' + escapeHtml(chat.genericTitle) + '" data-label="' + t.cardNameInIde + '" title="' + t.cardCopyTechnicalTitle + '">' +
                            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
                        '</button>' +
                    '</div>';
                }

                const noteHtml = '<div class="chat-note-row btn-edit-note' + (chat.note ? '' : ' empty') + '" data-uuid="' + chat.uuid + '" data-note="' + escapeHtml(chat.note || '') + '" title="' + t.cardEditNote + '">' +
                    (chat.note ? 
                        '<span class="note-label">' + t.cardNote + ': </span>' +
                        '<span class="note-text">' + escapeHtml(chat.note) + '</span>' : 
                        '<span class="note-text"><em>' + t.cardNote + '</em></span>'
                    ) +
                    '<span class="note-edit-icon" style="opacity: 0.6; margin-left: auto; cursor: pointer; font-size: 11px;">✏️</span>' +
                '</div>';

                card.innerHTML = '<div class="chat-info">' +
                    '<div class="chat-title-row">' +
                        '<div class="chat-title-container">' +
                            '<h3 class="chat-title btn-open-folder" data-uuid="' + chat.uuid + '" title="' + t.cardOpenFolder + '">' + escapeHtml(chat.displayTitle || chat.title) + '</h3>' +
                            '<button class="copy-btn btn-copy hover-copy-btn" data-text="' + escapeHtml(chat.displayTitle || chat.title) + '" data-label="' + t.cardNameInIde + '" title="' + t.cardCopyTitle + '">' +
                                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
                            '</button>' +
                        '</div>' +
                        badgeHtml +
                    '</div>' +
                    '<div class="chat-uuid-row">' +
                        '<span class="btn-copy" data-text="' + chat.uuid + '" data-label="UUID" title="' + t.cardCopyUuidTitle + '">UUID: ' + chat.uuid + '</span>' +
                        '<button class="copy-btn btn-copy" data-text="' + chat.uuid + '" data-label="UUID" title="' + t.cardCopyUuidBtnTitle + '">' +
                            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
                        '</button>' +
                    '</div>' +
                    workspaceHtml +
                    dbTitleHtml +
                    noteHtml +
                    '<div class="chat-meta-row">' +
                        '<div class="meta-item" title="' + t.cardCreatedTitle + '">' +
                            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
                            '<span>' + t.cardCreated + ': ' + dateStr + '</span>' +
                        '</div>' +
                        '<div class="meta-item" title="' + t.cardFilesTitle + '">' +
                            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
                            '<span>' + chat.file_count + ' ' + t.cardFilesOnDisk + '</span>' +
                        '</div>' +
                        '<div class="meta-item" title="' + t.cardVolumeTitle + '">' +
                            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>' +
                            '<span>' + chat.size_str + '</span>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="chat-actions">' +
                    actionHtml +
                '</div>';

                chatListView.appendChild(card);
            }

            // Bind card buttons
            document.querySelectorAll('.btn-delete').forEach(btn => {
                btn.addEventListener('click', () => {
                    const uuid = btn.getAttribute('data-uuid');
                    const title = btn.getAttribute('data-title');
                    chatToDelete = uuid;
                    document.getElementById('modal-chat-title').innerText = title;
                    deleteModal.style.display = 'flex';
                });
            });

            document.querySelectorAll('.btn-restore').forEach(btn => {
                btn.addEventListener('click', () => {
                    const uuid = btn.getAttribute('data-uuid');
                    const title = btn.getAttribute('data-title');
                    showLoading();
                    sendToExtension({ command: 'restore', uuid: uuid, title: title });
                });
            });

            document.querySelectorAll('.btn-open-folder').forEach(btn => {
                btn.addEventListener('click', () => {
                    const uuid = btn.getAttribute('data-uuid');
                    sendToExtension({ command: 'openFolder', uuid: uuid });
                });
            });

            document.querySelectorAll('.btn-open-search').forEach(btn => {
                btn.addEventListener('click', () => {
                    const uuid = btn.getAttribute('data-uuid');
                    sendToExtension({ command: 'openSearch', uuid: uuid });
                });
            });

            document.querySelectorAll('.open-ws-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const path = btn.getAttribute('data-path');
                    sendToExtension({ command: 'openProjectFolder', path: path });
                });
            });

            document.querySelectorAll('.btn-launch').forEach(btn => {
                btn.addEventListener('click', () => {
                    const uuid = btn.getAttribute('data-uuid');
                    const title = btn.getAttribute('data-title');
                    sendToExtension({ command: 'activateChat', uuid: uuid, title: title });
                });
            });

            document.querySelectorAll('.btn-action-note').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const card = btn.closest('.chat-card');
                    if (card) {
                        const noteRow = card.querySelector('.chat-note-row');
                        if (noteRow) {
                            noteRow.classList.add('editing');
                            noteRow.click();
                        }
                    }
                });
            });

            document.querySelectorAll('.btn-edit-note').forEach(row => {
                row.addEventListener('click', (e) => {
                    // Prevent multiple inputs
                    if (row.querySelector('input')) return;
                    
                    const uuid = row.getAttribute('data-uuid');
                    const currentVal = row.getAttribute('data-note') || '';
                    const textSpan = row.querySelector('.note-text');
                    
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'note-inline-input';
                    input.value = currentVal;
                    input.placeholder = t.cardAddNote;
                    
                    textSpan.replaceWith(input);
                    input.focus();
                    
                    let finished = false;
                    const finishEdit = (save) => {
                        if (finished) return;
                        finished = true;
                        if (save) {
                            const newVal = input.value.trim();
                            if (newVal !== currentVal) {
                                showLoading();
                                sendToExtension({ command: 'saveNote', uuid: uuid, note: newVal });
                            } else {
                                renderList();
                            }
                        } else {
                            renderList();
                        }
                    };
                    
                    input.addEventListener('keydown', (evt) => {
                        if (evt.key === 'Enter') {
                            finishEdit(true);
                        } else if (evt.key === 'Escape') {
                            finishEdit(false);
                        }
                    });
                    
                    input.addEventListener('blur', () => {
                        // Wait a tiny bit in case enter key is pressed (which handles blur too)
                        setTimeout(() => finishEdit(true), 150);
                    });
                });
            });

            document.querySelectorAll('.btn-copy').forEach(btn => {
                btn.addEventListener('click', () => {
                    const text = btn.getAttribute('data-text');
                    const label = btn.getAttribute('data-label') || 'Текст';
                    sendToExtension({ command: 'copyToClipboard', text: text, label: label });
                });
            });
        }

        function escapeHtml(text) {
            return text
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }
    </script>
</body>
</html>`;

    for (const key of Object.keys(t)) {
        html = html.replace(new RegExp('{{' + key + '}}', 'g'), t[key]);
    }
    return html;
}
