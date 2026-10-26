# Agentic OS

## Firewall (one-time, admin PowerShell)

The server and the decider sidecar bind to `127.0.0.1` only. As a second layer, block inbound connections to their ports:

```powershell
New-NetFirewallRule -DisplayName "AgenticOS block inbound" -Direction Inbound -LocalPort 3000,8009 -Protocol TCP -Action Block
```
