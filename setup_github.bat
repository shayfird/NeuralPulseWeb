@echo off
echo Configuring NeuralPulse GitHub Repository...
set /pREPO_URL="Enter your GitHub Repository URL (e.g., https://github.com/username/neuralpulse.git): "

if "%REPO_URL%"=="" goto error

git remote add origin %REPO_URL%
git branch -M main
git push -u origin main

echo.
echo Repository connected and initial push complete!
pause
exit

:error
echo Error: Repository URL is required.
pause
exit
