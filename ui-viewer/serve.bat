@echo off
echo Starting local web server for UI viewer...
echo.
echo The viewer will be available at: http://localhost:8888
echo Press Ctrl+C to stop the server
echo.
npx http-server . -p 8888 -c-1 --cors