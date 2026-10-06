@echo off
cd /d "%~dp0"
python -c "import importlib.metadata as m; import PIL, rembg, onnxruntime; assert tuple(map(int, m.version('rembg').split('.')[:3])) >= (2, 0, 85)" >nul 2>&1
if errorlevel 1 python -m pip install -r requirements.txt
if errorlevel 1 goto failed
python app.py --open
if errorlevel 1 goto failed
exit /b
:failed
echo Nie udalo sie uruchomic aplikacji. Wymagany Python 3.11 lub nowszy.
pause
