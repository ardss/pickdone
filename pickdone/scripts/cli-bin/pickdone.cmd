@echo off
rem PickDone CLI shim - lives at <install>\resources\bin, runs the bundled CLI next to it
node "%~dp0..\cli\pickdone.js" %*
