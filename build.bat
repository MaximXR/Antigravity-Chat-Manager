@echo off
echo ==================================================
echo Antigravity Chat Manager Build Automation
echo ==================================================

echo [1/5] Checking and installing npm dependencies...
call npm install

echo [2/5] Checking Python installation...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python was not found in the system path!
    echo Please make sure Python is installed and added to your PATH.
    exit /b 1
) else (
    echo Python is installed.
)

echo [3/5] Cleaning up old build trash...
if exist *.lock_test del /q /f *.lock_test
if exist extension_debug.log del /q /f extension_debug.log
if exist *.vsix del /q /f *.vsix
if exist dist\*.vsix del /q /f dist\*.vsix

echo [4/5] Packaging extension via vsce...
call npx @vscode/vsce package

echo [5/5] Moving and renaming the packaged VSIX to dist/...
node -e "const fs = require('fs'); const path = require('path'); const pkg = JSON.parse(fs.readFileSync('package.json')); const gen = 'maximxr.antigravity-chat-manager-' + pkg.version + '.vsix'; const tgt = path.join('dist', 'Antigravity-chat-manager-' + pkg.version + '.vsix'); if (!fs.existsSync('dist')) { fs.mkdirSync('dist'); } if (fs.existsSync(gen)) { fs.renameSync(gen, tgt); console.log('Successfully moved and renamed ' + gen + ' to ' + tgt); } else { const files = fs.readdirSync('.').filter(f => f.endsWith('.vsix') && f.includes('antigravity-chat-manager')); if (files.length > 0) { fs.renameSync(files[0], tgt); console.log('Successfully moved and renamed ' + files[0] + ' to ' + tgt); } else { console.error('Error: Packaged VSIX file was not found!'); process.exit(1); } }"

if %errorlevel% neq 0 (
    echo [ERROR] Move/Rename failed!
    exit /b 1
)

echo ==================================================
echo Build finished successfully!
echo Output VSIX is ready at: dist/
echo ==================================================
