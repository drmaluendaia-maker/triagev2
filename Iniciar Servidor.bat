@echo off
title Servidor de Triage v2

echo Verificando e instalando dependencias (si es necesario)...
call npm install

echo.
echo Iniciando servidor de Triage v2...
echo.

node servidor.js
