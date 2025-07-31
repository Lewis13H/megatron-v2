@echo off
echo Exporting database data...
cd ..
npx tsx ui-viewer/scripts/export-data.ts
echo.
echo Export complete! Open ui-viewer/index.html in your browser to view the data.
pause