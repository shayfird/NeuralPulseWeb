@echo off
echo Starting NeuralPulse Auto-Sync...
echo Press Ctrl+C to stop.

:loop
git add .
git commit -m "Auto sync update - %date% %time%"
git push origin main
timeout /t 60
goto loop
