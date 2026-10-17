# Análise do editor do Tinkercad e plano para o tinker-open-cad

Fonte: scripts do editor capturados em 2026-10-12 com REA (leitura estática, nada foi executado).
Alvo: `https://www.tinkercad.com/things/<id>/edit`. Código é da Autodesk: este documento descreve
arquitetura e técnicas para reimplementar do zero. Nenhum trecho deve ser copiado.

Legenda: **[obs]** observado no código · **[inf]** inferência · **[?]** não verificado.

## 1. Como o Tinkercad é montado

| Peça | Onde | Notas |
|---|---|---|
| Shell da página | `www.tinkercad.com` | só carrega o editor e checa WebGL (`webgl_check.js`) [obs] |
| Editor | `editor.tinkercad.com/assets_v2_*/js/appBundle.js` (8,7 MB) | exporta `WebCAD3DEditor`; webpack; THREE, jQuery, lodash, Hammer, TWEEN, marked entram como externos [obs] |
| UI | `react-bundle.js` (1,8 MB), `vendorBundle.js` (1,3 MB) | React + mathjs (há `createSchur`, `gamma` etc. no bundle) [obs] |
| Colaboração | `colab.tinkercad.com/collaboration/jsapi/v1` | cliente baseado em ShareJS/BrowserChannel [obs] |
| Servidor de geometria ("csgHost") | endpoints abaixo | todo o cálculo pesado fica aqui [obs] |
| Workers | `exportWorker.js`, `physicsWorker.js`, `ffmpeg/ffmpeg.js` + worker inline de voxels→STL | os dois primeiros ficam atrás de URL com hash (S3 `AccessDenied` sem ela) [obs] |
| Sem WASM | nenhuma ocorrência de `WebAssembly`/`.wasm` no appBundle nem nos workers lidos | [obs] |

Renderização: `THREE.WebGLRenderer`, `BufferGeometry`, eixo Z para cima (`zUp:true`) [obs].
Existem extensões do editor registradas por nome: `TinkercadScene`, `DefaultRenderer`, `Navigating`,
`ViewCube`, `Import`, `ImportDialog`, `UndoRedo`, `CopyPaste`, `AR`, `DragDropNode`… [obs].
Ferramentas de desenho 2D (sketch): linha, bézier, curva suave, abrir/fechar caminho, contorno
(`PATH_STROKE_TOOL`), mover/selecionar pontos [obs].

## 2. Modelo de documento

- Árvore de **nós**. Cada nó: `dataType`, `params`, `matrix` (4x4), `tags`, filhos [obs].
- `dataType` primitivos: `preset`, `legacy`, `legacy-xy|xyz|shapegenerator|stl|svg`, `import`,
  `part`/`epart`/`rpart`/`cpart`, `asm`. Grupos: `csg`, `cbshape`. Restrições: `constraint` [obs].
- **Polaridade de volume**: cada nó tem `volumePolarity` (positivo = sólido, negativo = furo).
  Um grupo = união dos positivos menos os negativos [obs/inf].
- Outros campos enviados ao servidor: `isMulticolor`, `isMixedOpacity`, `extra.color`,
  `extra.opacity`, `extra.physicalMaterial`, `extra.locks` (bitmask de travas) [obs].
- Undo/redo, copiar/colar, travar (`Locks`), agrupar/desagrupar, alinhar, espelhar, régua,
  plano de trabalho (workplane), grade com snap, dropar no plano [obs: ocorrências no bundle].
- Autosave via `CircuitsRecorder` (nome interno do projeto legado, é o `docId`) [obs].

## 3. Pipeline de geometria (o coração)

```
UI/nós  ->  prepareCSGNode()  ->  JSON "documentRecipe"
        ->  POST {csgHost}/evaluate?docId=..   (x-www-form-urlencoded)
        <-  malha v2 {indices, vertices, norms, tricols, bounds, edges}
        ->  buildCSGGeometry() -> THREE.BufferGeometry
```

- **Cache cliente** por hash do JSON (sem opacidade/`isMixedOpacity`), até 384 entradas, FIFO [obs].
- A receita omite a `matrix` do nó raiz, então mover o grupo não reavalia a geometria [obs].
- **Formas paramétricas**: `GET {csgHost}/parts/evaluate/{id}?dt=..&type=..&params=..` [obs].
- **Geradores de forma** (API em JS, `argumentValue(args, nome, padrão)`): `box, roundBox, simpleBox,
  cylinder, halfCylinder, sphere, halfSphere, torus(+thick/thin), tube(+thick/thin, tube2), pyramid,
  wedge, roof, hexagonalPrism, icosahedron, paraboloid, banana, heart, star, extrudeStar, ring,
  text, svg, sketch, sketchRevolve, scribble, trace, splineExtrusion, offsetPolygon, imagePlane`
  e restrições (`axle`, `slider`, `coneTwist`) [obs].
- **Malha para o renderer**: arestas vivas são calculadas no cliente: duas faces adjacentes viram
  aresta se o ângulo entre normais passa de ~35° (`cos 35°`); faces coplanares (<0,01°) são ignoradas.
  O array de arestas usa 5 inteiros por aresta (v0, v1, face A, face B, flag) [obs].
- Normais por vértice e `tricols` (cor por triângulo, RGBA em inteiro) acompanham a malha [obs].

## 4. Importar e exportar

| Formato | Entrada | Saída |
|---|---|---|
| STL | `THREE STLLoader` no cliente; para virar nó, o arquivo sobe via `POST /import` | `POST /export` com `outputType=stl` |
| SVG | `DOMParser` no cliente; sobe via `POST /import` serializado com `XMLSerializer` | exporta SVG (`exportSVG`) |
| OBJ / PLY / VTK | loaders registrados (`obj`, `ply`, `vtk`) | `obj` (e `usdz` é tratado como `obj`) |
| Fusion 360 | — | `/fusion/export?type=smb`, `/downloadFusion3D` |

- `/import?docId=` recebe `FormData`: `file`, `fileType`, `scale`, `fileName`, `params`; devolve `id`.
  Cabeçalho `X-CSRF-Token` e cookies (`withCredentials`) [obs].
- `/export?docId=` recebe `FormData`: `document`, `needRepair`, `supportDownloadDirectly`,
  `outputType`, `isSimpleDoc`; devolve blob (download direto) ou um id para `/downloadExport?id=` [obs].
- Há reparo de malha (`needRepair`) no servidor [obs]; como é feito [?].

## 5. Texto e fontes (o ponto que você quer mudar)

Como o Tinkercad faz [obs]:
- Fontes fixas: *Multilanguage, Sans (Droid Sans), Sans Mono, Serif, Braille*.
- As quatro últimas são fontes `*.typeface.json` (formato do three.js) empacotadas no bundle e
  extrudadas com `THREE.TextGeometry` (`size, height, curveSegments, bevel*`).
- *Multilanguage* chama `getFontTypes`/`buildFontLib`, que monta no servidor uma biblioteca de glifos
  só com os caracteres usados (famílias Noto, incluindo árvores árabes/urdu) e o cliente extruda.
- Não existe nenhuma leitura de fontes do sistema (`queryLocalFonts` = 0 ocorrências).

Como vamos fazer, usando as fontes instaladas no seu computador:

1. **Listar**: `window.queryLocalFonts()` (Local Font Access API, Chrome/Edge, exige permissão do usuário
   e contexto seguro; `localhost` serve). Cada item é um `FontData` com `family`, `style`,
   `postscriptName` e `blob()` com os bytes do arquivo (TTF/OTF).
2. **Ler glifos**: `opentype.js` (ou `fontkit`) -> `font.getPath(texto, 0, 0, size)` ->
   contornos (linhas + curvas quadráticas/cúbicas), já com kerning e ligaduras básicas.
   Para scripts complexos (árabe, indic) usar `harfbuzzjs` (WASM) para o *shaping* antes.
3. **Achatar curvas** em polilinhas (tolerância = `curveSegments`), agrupar contornos com regra
   *non-zero* para formar `CrossSection` com furos (o miolo do "O", "A", etc.).
4. **Extrudar** com o kernel (seção 6): `CrossSection.extrude(height)`; chanfro/bevel opcional via
   `offset` em camadas ou `ExtrudeGeometry` do THREE apenas para visualização.
5. **Fallbacks**: Firefox/Safari não têm a API -> botão "carregar arquivo de fonte (.ttf/.otf/.woff)"
   e fontes embutidas. Se for desktop (Electron/Tauri), dá para varrer `C:\Windows\Fonts` e
   `%LOCALAPPDATA%\Microsoft\Windows\Fonts` direto com `font-list`/`font-kit`.
6. Guardar no documento o `postscriptName` + um hash do arquivo, para avisar quando a fonte
   faltar em outra máquina (e permitir "converter texto em formas" para ficar portátil).

## 6. Proposta de arquitetura

Tudo no navegador (sem backend próprio no começo):

| Camada | Escolha | Motivo |
|---|---|---|
| Linguagem/build | TypeScript + Vite | |
| Render e interação | three.js (+ `TransformControls`, `OrbitControls`) | mesmo motor do Tinkercad |
| Kernel de sólidos | `manifold-3d` (WASM) | união, subtração, interseção, extrusão, revolução, offset e hull em tempo real; substitui o servidor `/evaluate` |
| 2D (sketch/SVG/texto) | Manifold `CrossSection` + `clipper2` se precisar | |
| Fontes | Local Font Access API + `opentype.js` (+ `harfbuzzjs`) | seção 5 |
| Import | STL/OBJ/3MF via loaders do three; SVG via `SVGLoader` -> `CrossSection` -> extrusão | |
| Export | STL (binário), OBJ, 3MF, SVG (corte de plano), GLB | feitos no cliente, em Worker |
| Estado | documento em JSON (árvore de nós igual à seção 2) + histórico de comandos para undo | |
| Persistência | IndexedDB + exportar/importar arquivo `.tocad.json` | colaboração fica fora do escopo inicial |

Fluxo de avaliação (equivalente ao `/evaluate`): nó -> Worker com Manifold -> malha
`{positions, indices, normals, triColors, edges}` -> cache por hash da receita -> `BufferGeometry`.

## 7. Roteiro sugerido

1. Esqueleto Vite + cena three.js (grade, plano de trabalho, câmera, ViewCube, seleção/gizmos).
2. Modelo de nós + primitivas (caixa, cilindro, esfera, cone, cunha, toro) com `volumePolarity`.
3. Kernel Manifold em Worker: agrupar = (união dos sólidos) − (união dos furos); cache por hash.
4. Undo/redo, copiar/colar, alinhar, espelhar, snap, réguas.
5. **Texto com fontes locais** (seção 5), com "converter em formas".
6. Import/export STL e SVG; depois OBJ/3MF.
7. Sketch 2D (linha/bézier) + extrusão/revolução.
8. Persistência local e, só depois, colaboração.

## 8. Lacunas

- O servidor `csgHost` e como ele repara malhas, unifica coplanares e calcula `Edges`: não observado.
- `exportWorker.js`/`physicsWorker.js`: não lidos (URL com hash). O formato das mensagens é visível
  só do lado do chamador (`{type, meshArray}` -> `{result}`).
- Respostas reais de `/import`, `/evaluate` e `/export`: o REA só viu scripts, não corpos de rede.
- Hospedagem/URL do `csgHost`: vem de configuração da página (`csgHost`), valor não capturado.
