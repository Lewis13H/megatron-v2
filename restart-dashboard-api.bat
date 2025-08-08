@echo off
echo Stopping dashboard API servers...
taskkill /F /FI "WINDOWTITLE eq dashboard:serve*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq *dashboard-api*" >nul 2>&1

echo Waiting for ports to be released...
timeout /t 2 /nobreak >nul

echo Starting dashboard API server...
start "dashboard:serve" npm run dashboard:serve

echo Dashboard API server restarted successfully!
echo Access at: http://localhost:3000