# CajuCAD

CajuCAD é um modelador 3D no navegador, no estilo Tinkercad: formas básicas, furos, grupos com booleanas,
texto com **as fontes instaladas no seu computador**, importação e exportação para impressão 3D.

```bash
npm install
npx install-electron    # baixa o Electron (o npm 11 não roda isso sozinho)

npm run desktop         # app desktop em modo desenvolvimento
npm run desktop:dist       # instalador leve (usa o Bambu Studio instalado para fatiar)
npm run desktop:dist:full  # instalador completo (inclui o fatiador; veja abaixo)

npm run dev             # versão web em http://localhost:5173 (Chrome/Edge para fontes do sistema)
```

O app desktop (`electron/`) roda a mesma interface e adiciona serviços nativos: as fontes do
computador são lidas direto das pastas do sistema, sem pedir permissão (inclui `.ttc`).

## Como funciona

| Parte | Arquivo | Tecnologia |
|---|---|---|
| Documento, desfazer/refazer | `src/core/store.ts`, `types.ts` | árvore de nós em JSON |
| Sólidos e booleanas | `src/core/geometry.ts` | [Manifold](https://github.com/elalish/manifold) (WASM) |
| Formas e parâmetros | `src/core/shapes.ts` | |
| Texto e fontes | `src/core/fonts.ts`, `src/ui/fontPicker.ts` | Local Font Access API + opentype.js |
| Importar/exportar | `src/core/io.ts` | STL, OBJ, 3MF, SVG → STL, OBJ, GLB |
| Cena 3D | `src/view/viewport.ts` | three.js |
| Interface | `src/ui/*`, `src/styles.css` | TypeScript puro + CSS |

- Cada nó tem `hole`: ao agrupar, sólidos são unidos e furos subtraídos.
- O texto guarda o contorno já calculado (`params.outline`), então o projeto abre em outro
  computador mesmo sem a fonte instalada.
- O projeto é salvo automaticamente no navegador (IndexedDB) e pode ser salvo como `.ocad.json`.

A análise do Tinkercad que originou este projeto está em `docs/ANALISE-TINKERCAD.md`.

## Imprimir (app desktop)

O botão **Imprimir** usa o Bambu Studio instalado no computador:

1. cada cor do modelo vira um filamento (ou use **Meus filamentos** / **Ler do AMS**);
2. **Fatiar** mostra tempo, gramas por filamento e a prévia da mesa;
3. **Projeto .3mf** abre no Bambu Studio; **G-code .3mf** vai no cartão SD;
4. **Impressora na rede** (Modo LAN): descobre, conecta, lê o AMS e envia direto.

Detalhes e o que ainda não foi testado numa impressora real: `docs/ANALISE-BAMBU-STUDIO.md`.

### Instalador completo (sem precisar instalar o Bambu Studio)

`npm run desktop:dist:full` monta `build/slicer-engine/` copiando e enxugando o motor de fatiamento
de um Bambu Studio instalado **neste** computador (178 MB, sem interface, sem o plugin de rede
proprietário, com as bibliotecas do Visual C++ ao lado do executável) e o inclui no instalador
(`CajuCAD-Setup-<versão>-completo.exe`, ~150 MB, em `%LOCALAPPDATA%\opencad-build-completo`).

- Se o computador já tiver o Bambu Studio, o CajuCAD usa o instalado; senão usa o embutido.
- O Bambu Studio é AGPL-3.0 (https://github.com/bambulab/BambuStudio). O pacote leva o aviso em
  `NOTICE-CajuCAD.txt` e o CajuCAD só o executa como programa separado. Antes de distribuir
  amplamente fora do seu uso interno, confira os termos da licença.
- Para testar como num PC novo: `OPENCAD_PREFER_BUNDLED=1` força o fatiador embutido.
