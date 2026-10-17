# Análise do Bambu Studio: fatiamento, cores e envio para a impressora

Data: 2026-10-12. Bambu Studio 02.08.02.61 instalado em `C:\Program Files\Bambu Studio`.
Legenda: **[obs]** observado nesta máquina · **[inf]** inferência · **[doc]** documentação pública/comunidade, não verificado aqui.

## 1. Como o programa é dividido

| Peça | Arquivo | Aberto? |
|---|---|---|
| Lançador | `bambu-studio.exe` (160 KB) | — [obs] |
| Programa inteiro (interface + fatiador, derivado do PrusaSlicer) | `BambuStudio.dll` (109 MB) | sim, código AGPL no GitHub `bambulab/BambuStudio` |
| Rede (nuvem, rede local, câmera, fila) | `%APPDATA%\BambuStudio\plugins\bambu_networking.dll` (23 MB) | **não**: binário protegido/ofuscado (seções `.;2G`, `.(/2`, `."]E`, quase sem texto legível) [obs] |
| Câmera/vídeo | `BambuSource.dll`, `live555.dll`, `agora_rtc_sdk.dll` | não [obs] |

O plugin exporta 151 funções C `bambu_network_*` e `ft_*` [obs]. As de impressão:
`connect_printer`, `start_discovery`, `start_local_print`, `start_local_print_with_record`,
`start_print` (nuvem), `start_send_gcode_to_sdcard`, `start_sdcard_print`,
`send_message_to_printer`, `sync_ams_filaments`, `set_on_ssdp_msg_fn`, `set_on_local_message_fn`.

O Studio entrega ao plugin `dev_id`, `dev_ip`, usuário e senha (o *access code* da impressora) [obs, strings de log].
Existem os modos "LAN only" e "Developer Mode" [obs, strings da interface].

## 2. Fatiar (testado, funciona sem impressora)

O Bambu Studio fatia pela linha de comando, sem abrir a janela [obs]:

```
bambu-studio.exe --slice 0
  --load-settings "<machine.json>;<process.json>"
  --load-filaments "<filamento1.json>;<filamento2.json>"
  --outputdir <pasta> --export-3mf saida.gcode.3mf  entrada.stl|entrada.3mf
```

- Os presets oficiais estão em `%APPDATA%\BambuStudio\system\BBL\{machine,process,filament}` [obs].
- Um cubo de 20 mm para a A1 fatiou em ~1 s e gerou `saida.gcode.3mf`, `plate_1.gcode` e `result.json`
  (tempo estimado, filamento usado, erros) [obs].
- `.gcode.3mf` = ZIP com `Metadata/plate_1.gcode` (+ `.md5`), miniaturas PNG, `slice_info.config`,
  `project_settings.config` (cores/tipos de filamento), `model_settings.config` (objeto → `extruder`) [obs].

## 3. Cores por filamento

- Cada objeto/parte do projeto tem `<metadata key="extruder" value="N"/>` em `Metadata/model_settings.config`;
  as cores ficam em `filament_colour` de `Metadata/project_settings.config` [obs].
- Um 3MF genérico tem a atribuição ignorada: saiu um filamento só [obs].
- Um 3MF que se declara projeto Bambu (`BambuStudio:3mfVersion`) mas está incompleto derruba o
  fatiador (`0xC0000005`) [obs]. Logo, o OpenCAD precisa gerar o pacote de projeto completo
  (modelo em `3D/Objects/*.model`, `model_settings.config` com placa, `project_settings.config`), seguindo um
  projeto real gerado pelo Studio [inf].
- Na hora de imprimir, o Studio casa os filamentos do projeto com os carretéis do AMS (`ams_mapping`,
  escolhe pela cor mais próxima: "picked F(%02d) AMS(%02d), distance=") [obs].

## 4. Envio pela rede (não testado: não há impressora)

As mensagens são montadas no Studio, em código aberto. Os nomes estão confirmados no binário [obs]:
`print.command = "project_file"`, `param = "Metadata/plate_N.gcode"`, `url`, `use_ams`, `ams_mapping`,
`timelapse`, `bed_leveling`, `flow_cali`, `plate_idx`, `subtask_name`, `sequence_id`, `pushall`.

O transporte fica dentro do plugin protegido e não pôde ser observado aqui. Pela documentação pública [doc]:
- Descoberta: anúncios SSDP em UDP na rede local (`urn:bambulab-com:device:3dprinter:1`).
- Controle: MQTT com TLS na porta 8883, usuário `bblp`, senha = access code;
  tópicos `device/<serial>/request` e `device/<serial>/report`.
- Arquivo: FTPS implícito na porta 990, upload do `.gcode.3mf`; depois o comando `project_file` aponta para ele.
- Firmwares recentes restringem controle por terceiros, a não ser que a impressora esteja em
  **LAN only + Developer Mode**.

Consequência para o OpenCAD: o navegador não abre MQTT/TLS cru nem FTPS. O envio exige uma
**ponte local** (pequeno programa Node no computador) ou continuar usando o Bambu Studio para enviar.

## 5. Proposta para o OpenCAD

1. **Filamentos no OpenCAD**: lista de slots (cor + tipo); cada objeto escolhe um slot e é pintado com essa cor.
2. **Exportar projeto Bambu (.3mf)** com objetos separados e filamento de cada um, para abrir no Bambu Studio
   (ou em qualquer impressora Bambu, via Studio/Handy).
3. **Fatiar localmente** com uma ponte Node que chama o CLI do Bambu Studio já instalado e devolve tempo,
   gramas e o `.gcode.3mf` (pendrive/cartão microSD).
4. **Enviar pela rede** (opcional, quando houver impressora): a mesma ponte faz SSDP + FTPS + MQTT.

Próximos passos de engenharia reversa, se necessário: instalar o Ghidra para o REA descompilar o
`BambuStudio.dll`, ou observar o tráfego de rede do Studio com uma impressora real (só portas e
destinos; o conteúdo vai cifrado).

## 6. O que foi implementado no OpenCAD (app desktop)

| Parte | Onde | Como foi verificado |
|---|---|---|
| Presets do Bambu achatados (a CLI não segue `inherits`; sem isso a A1 usava mesa de 200x200 em vez de 256x256) | `electron/bambu-presets.cjs` | fatiamento real, mesa 256x256 conferida no projeto gerado |
| Fatiar e gerar projeto pelo `bambu-studio.exe --slice` | `electron/slicer.cjs` | fatiamento real: tempo, gramas por filamento, prévia da mesa, torre de limpeza posicionada |
| Cores por filamento: `--load-filament-ids` + presets com `filament_colour` | idem | projeto reabre no Studio com as mesmas cores (2 filamentos) |
| Placa da mesa (PETG não fatia em "Cool Plate") | idem | erro reproduzido e corrigido |
| Descoberta (SSDP), MQTT/TLS, AMS, FTPS, `project_file` | `electron/printer.cjs` | **contra um simulador local**, não contra uma impressora real |
| Interface | `src/ui/printDialog.ts`, `src/core/print.ts`, `src/core/filaments.ts` | no app, de ponta a ponta com o simulador |

### Ainda não verificado numa Bambu de verdade
- O transporte exato do plugin fechado (`bambu_networking.dll`): o código segue a documentação da comunidade.
- `md5` vazio no comando `project_file`, `ams_mapping2`, e o envio para a raiz do FTPS: são os pontos mais prováveis de precisar de ajuste.
- Firmwares novos podem exigir Modo LAN + Modo Desenvolvedor.
- O simulador está fora do projeto; ele valida o protocolo que o código assume, não o que a impressora faz.

### Primeiro teste numa Bambu real (2026-10-14)
Conectou, leu o AMS, fatiou e identificou os filamentos. O envio falhou com
`553 Could not create file` (FTP). Causa mais provável: o FTP da impressora grava no cartão
microSD, e esse erro aparece sem cartão, com o cartão cheio ou protegido contra gravação.
Mudanças feitas a partir disso (ainda não confirmadas na impressora): o envio tenta a raiz e depois
`/cache`; o comando de imprimir aponta para onde o arquivo caiu; a janela mostra o estado do cartão;
os detalhes do FTP vão para `%APPDATA%\OpenCAD\printer-log.txt` (nunca o código de acesso).
