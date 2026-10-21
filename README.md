# Window Dock

Dock no canto inferior esquerdo da status bar para navegar entre janelas do VS Code.

- Clique num ícone → foca a janela (ou abre, se estiver fechada).
- `⚙` → fixar janela atual / outra pasta, renomear, trocar ícone, reordenar, desafixar.
- Atalhos pela posição no dock: 1º item `Cmd+1`, 2º `Cmd+2`… (Mac) / `Ctrl+Alt+1..9`; `Ctrl+Alt+0` (trocar de janela).
- `•` = aberta, fundo cinza = janela atual, apagado = fixada mas fechada.

Atalho customizado por nome em `keybindings.json`:

```json
{ "key": "cmd+shift+1", "command": "windowDock.open", "args": "Site" }
```
