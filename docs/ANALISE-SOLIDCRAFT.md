# Análise do SolidCraft 0.30.1 (para o CajuCAD)

Fonte: instalação em `C:\Program Files\SolidCraft` e a lista de comandos que o próprio programa
publica (`solidcraft-cli commands`, 570 comandos com rótulo, painel, atalho e parâmetros).

## O que é

- CAD **paramétrico B-rep** no estilo Fusion 360, escrito em Rust (interface egui, núcleo
  geométrico `truck`). Licença **MIT ou Apache-2.0** ("SolidCraft contributors", 2026).
- Modelo de trabalho: **esboço 2D com restrições → recurso 3D (extrudar, revolver…) → linha do
  tempo** que pode ser editada e refeita. Tem montagem com juntas, chapa metálica, superfícies,
  renderização realista, servidor MCP para IA e uma CLI completa.
- O CajuCAD é outro tipo de programa: **formas prontas + furos + agrupar** (estilo Tinkercad),
  com malhas e Manifold (CSG). Muitas funções do SolidCraft dependem de B-rep (faces e arestas
  exatas) e não têm equivalente direto em malha.

## Comandos por área (quantidade)

| Área | Exemplos | Qtde |
|---|---|---|
| Esboço: criar | linha, retângulos, círculos, arcos, polígonos, rasgos, elipse, spline, texto | 52 |
| Esboço: restrições | horizontal/vertical, coincidente, tangente, igual, paralelo, simetria, auto | 15 |
| Esboço: modificar/padrão | filete, chanfro, offset, aparar, estender, espelhar, padrões | 15 |
| Esboço: inserir | DXF, SVG, imagem de fundo (canvas), decalque | 5 |
| Sólido: criar | extrudar, revolver, varrer, loft, caixa/cilindro/esfera/toro/cone, padrões, espelhar, furo, cano, rosca, mola, nervura, gravar em relevo | 24 |
| Sólido: modificar | filete, chanfro, combinar, escalar, casca, ângulo de saída, dividir corpo/face, empurrar/puxar, mover/copiar, alinhar, aparência | 20 |
| Construção | planos, eixos e pontos de referência | 20 |
| Inspecionar | medir, corte (seção), interferência, lista de materiais, centro de massa, análises de curvatura | 15 |
| Montagem | componentes, juntas, engrenagens, contato, estudo de movimento, vista explodida | 18+ |
| Superfícies | patch, costurar, aparar, engrossar, filete de superfície | 20 |
| Chapa metálica / plástico / soldagem | flange, dobra, planificação, snap-fit, ressalto, perfis estruturais | 20 |
| Renderização | imagem realista, luzes, lote de imagens | 60 |
| Arquivos | salvar malha, **enviar para o fatiador**, STEP, DXF | 16 |
| Linha do tempo / parâmetros / configurações | histórico editável, variáveis, tabelas | 43 |

## O que cabe no CajuCAD sem mudar o que já existe

**A. Encaixa direto (Manifold já faz a geometria)**
1. **Dividir corpo por um plano** (inclui "separar por altura" para pintar letras/relevo de outra cor).
2. **Interseção** (manter só a parte comum), além de juntar e furar, que já existem.
3. **Padrão retangular e circular** (cópias em grade ou em volta de um eixo).
4. **Medir** (distância entre pontos/faces) e **volume/peso estimado** por material.
5. **Vista em corte** (plano de seção para ver o interior).
6. **Furo com escareado/rebaixo** e **formas novas**: cano, mola (hélice), rosca simples.

**B. Possível com mais trabalho**
7. **Esboço 2D simples → extrudar/revolver** (linhas, arcos, retângulos, círculos, polígonos;
   sem restrições no começo). Manifold já tem `CrossSection.extrude` e `revolve`.
8. **Importar DXF** (já existe SVG).
9. **Filete/chanfro** só em formas prontas (caixas arredondadas já existem); em malha qualquer não.

**C. Exigem o motor B-rep (OpenCascade), adotado no plano abaixo**
- Restrições de esboço, linha do tempo paramétrica, superfícies, chapa metálica, montagem com
  juntas e movimento, STEP exato, renderização realista, configurações.

## Lista completa

`solidcraft-cli commands` gera o JSON com todos os comandos e parâmetros, caso seja preciso
consultar um item específico.

## Engenharia reversa com REA

O `solidcraft.exe` (172 MB, Rust) foi aberto no REA, mas a visão geral e a busca de textos
estouraram o tempo limite da ferramenta (5,5 min) por causa do tamanho do binário. Como o projeto
é aberto (MIT/Apache) e a CLI lista todos os comandos com parâmetros, essa lista foi a fonte.

## Plano adotado (modo "Peça paramétrica")

Motor OpenCascade (replicad) ao lado do modo atual; a peça vira uma malha comum na cena, então
grupos, furos, exportação e impressão Bambu continuam iguais.

1. Esboço 2D (linha, arco, retângulo, círculo, polígono, medidas), extrudar e revolver, histórico
   editável. **Feito.**
2. Restrições no esboço (planegcs), filete, chanfro, casca, furo, padrões. **Feito.**
3. Varrer, loft, rosca, STEP, medir, vista em corte. **Feito.** (A rosca é cortada na malha com o
   Manifold, porque o booleano do OpenCascade falha com hélices longas.)
4. Montagem simples: encaixar uma face na outra, juntas rígida, giratória e deslizante, e
   verificação de colisão, tudo na cena principal. **Feito.**
5. Esboço avançado: spline, elipse, ranhura, texto, aparar, estender, deslocar, projetar. **Feito.**
6. Planos, eixos e pontos de referência. **Feito.**
7. Sólido avançado e vários corpos: inclinação, nervura, tubo, mola, relevo, dividir, empurrar e
   puxar, escalar, mover e combinar. **Feito.**
8. Parâmetros, fórmulas, configurações e reordenar o histórico. **Feito.**
9. Superfícies: extrudar, revolver, remendo, preencher, costurar, aparar e engrossar. **Feito.**
10. Chapa metálica: chapa, aba, dobra e planificar. **Feito.** (No modo planificado, esboços feitos
    sobre faces dobradas não são remapeados.)
11. Montagem avançada: juntas cilíndrica, esférica e plana, contato, estudo de movimento (só
    visual), vista explodida, lista de peças com massa, centro de massa e cópias ligadas
    (componentes). **Feito.**

Fora do plano, por escolha: simulação, CAM, nuvem, renderização realista e perfis de solda e de
plástico. Também não há "dividir face".
