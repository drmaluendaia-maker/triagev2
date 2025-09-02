#!/bin/bash
echo "Verificando e instalando dependencias (si es necesario)..."
npm install

echo ""
echo "Iniciando servidor de Triage v2..."
echo ""

node servidor.js

echo ""
echo "El servidor se ha detenido."
