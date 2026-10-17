// Bambu Lab printers on the local network (LAN mode):
//  - discovery: SSDP announcements (UDP 1990 / 2021)
//  - status + AMS: MQTT over TLS, port 8883, user "bblp", password = access code
//  - file upload: implicit FTPS, port 990
//  - print: "project_file" command published over MQTT
// Protocol details follow the community documentation (OpenBambuAPI). This
// code has been exercised against a local simulator, not a real printer.
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mqtt = require('mqtt');
const ftp = require('basic-ftp');

const MODELS = {
  N1: 'A1 mini',
  N2S: 'A1',
  C11: 'P1P',
  C12: 'P1S',
  C13: 'X1E',
  'BL-P001': 'X1 Carbon',
  'BL-P002': 'X1',
  O1D: 'H2D',
  O1S: 'H2S',
  O1C: 'H2C',
  O1C2: 'H2C',
  O1E: 'H2D Pro',
  N7: 'P2S',
};

// ---------- discovery ----------

function parseSsdp(msg, rinfo) {
  const text = msg.toString('utf8');
  if (!/bambu/i.test(text)) return null;
  const h = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const serial = h.usn;
  if (!serial) return null;
  const code = h['devmodel.bambu.com'];
  return {
    ip: h.location || rinfo.address,
    serial,
    name: h['devname.bambu.com'] || serial,
    modelCode: code,
    model: MODELS[code] || code || 'Bambu Lab',
    lanMode: (h['devconnect.bambu.com'] || '').toLowerCase() === 'lan',
    bound: (h['devbind.bambu.com'] || '').toLowerCase() === 'occupied',
  };
}

/** Listen for printer announcements for `ms` milliseconds. */
function discover(ms = 6000, ports = [1990, 2021]) {
  return new Promise((resolve) => {
    const found = new Map();
    const sockets = [];
    const done = () => {
      sockets.forEach((s) => {
        try {
          s.close();
        } catch {
          /* already closed */
        }
      });
      resolve([...found.values()]);
    };
    for (const port of ports) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', () => {
        /* port busy (e.g. Bambu Studio is open): the other port may still work */
      });
      s.on('message', (msg, rinfo) => {
        const p = parseSsdp(msg, rinfo);
        if (p) found.set(p.serial, p);
      });
      s.bind(port, () => {
        try {
          s.addMembership('239.255.255.250');
        } catch {
          /* no multicast on this interface */
        }
        if (port === 1990) {
          const q = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1990\r\nMAN: "ssdp:discover"\r\nMX: 3\r\nST: urn:bambulab-com:device:3dprinter:1\r\n\r\n');
          try {
            s.send(q, 1990, '239.255.255.250');
          } catch {
            /* ignore */
          }
        }
      });
      sockets.push(s);
    }
    setTimeout(done, ms);
  });
}

// ---------- status ----------

const hex = (c) => (c && /^[0-9a-f]{6}/i.test(c) ? `#${c.slice(0, 6).toUpperCase()}` : null);

function trayInfo(t, amsId) {
  const type = t.tray_type || '';
  return {
    amsId,
    slot: Number(t.id),
    id: amsId * 4 + Number(t.id), // value used by ams_mapping
    color: hex(t.tray_color),
    type,
    name: t.tray_sub_brands || type,
    remain: typeof t.remain === 'number' && t.remain >= 0 ? t.remain : null,
    empty: !type && !hex(t.tray_color),
  };
}

/** Condensed view of the (merged) printer report for the UI. */
function summarize(state) {
  const amsList = state.ams?.ams ?? [];
  const trays = [];
  for (const a of amsList) for (const t of a.tray ?? []) trays.push(trayInfo(t, Number(a.id)));
  const ext = state.vt_tray ? { ...trayInfo({ ...state.vt_tray, id: 0 }, 0), id: 254, external: true } : null;
  return {
    gcodeState: state.gcode_state ?? null,
    percent: state.mc_percent ?? null,
    remainingMin: state.mc_remaining_time ?? null,
    layer: state.layer_num ?? null,
    totalLayers: state.total_layer_num ?? null,
    nozzle: state.nozzle_temper ?? null,
    nozzleTarget: state.nozzle_target_temper ?? null,
    bed: state.bed_temper ?? null,
    bedTarget: state.bed_target_temper ?? null,
    job: state.subtask_name || state.gcode_file || null,
    trays,
    external: ext,
    hasAms: trays.length > 0,
    // microSD present (null = the printer did not say).
    sdcard: typeof state.sdcard === 'boolean' ? state.sdcard : null,
  };
}

/** Reports carry only what changed: fold them into one running state. */
function merge(into, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'ams' && Array.isArray(v)) mergeUnits(into, v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) merge((into[k] ??= {}), v);
    else into[k] = v;
  }
}

/** `ams.ams` is a list of units addressed by id; each has trays addressed by id. */
function mergeUnits(into, units) {
  into.ams = Array.isArray(into.ams) ? into.ams : [];
  for (const u of units) {
    const cur = into.ams.find((x) => x.id === u.id);
    if (!cur) {
      into.ams.push(structuredClone(u));
      continue;
    }
    for (const [k, v] of Object.entries(u)) if (k !== 'tray') cur[k] = v;
    for (const t of u.tray ?? []) {
      cur.tray ??= [];
      const ct = cur.tray.find((x) => x.id === t.id);
      if (ct) Object.assign(ct, t);
      else cur.tray.push({ ...t });
    }
  }
}

class Session {
  constructor({ ip, serial, accessCode }, onStatus, opts = {}) {
    this.cfg = { ip, serial, accessCode };
    this.onStatus = onStatus;
    this.mqttPort = opts.mqttPort ?? 8883;
    this.ftpPort = opts.ftpPort ?? 990;
    /** Optional diagnostics sink: (line) => void. */
    this.log = opts.log;
    this.state = {};
    this.connected = false;
    this.seq = 0;
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const { ip, serial, accessCode } = this.cfg;
      const c = mqtt.connect(`mqtts://${ip}:${this.mqttPort}`, {
        username: 'bblp',
        password: accessCode,
        clientId: `cajucad_${crypto.randomBytes(4).toString('hex')}`,
        rejectUnauthorized: false, // printers use a self-signed certificate
        reconnectPeriod: 0,
        connectTimeout: timeoutMs,
        protocolVersion: 4,
      });
      this.client = c;
      const fail = (e) => {
        this.close();
        const msg = String(e?.message || e);
        reject(new Error(/not authori[sz]ed|bad user/i.test(msg) ? 'Código de acesso incorreto.' : /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|timeout/i.test(msg) ? 'Não consegui falar com a impressora. Confira o IP e se ela está em modo LAN.' : msg));
      };
      const timer = setTimeout(() => fail(new Error('timeout')), timeoutMs + 500);
      c.on('error', (e) => {
        clearTimeout(timer);
        if (!this.connected) fail(e);
      });
      c.on('close', () => {
        this.connected = false;
        this.onStatus({ connected: false });
      });
      c.on('connect', () => {
        c.subscribe(`device/${serial}/report`, (err) => {
          clearTimeout(timer);
          if (err) return fail(err);
          this.connected = true;
          this.requestAll();
          this.poll = setInterval(() => this.requestAll(), 15000);
          resolve();
        });
      });
      c.on('message', (_topic, payload) => {
        let msg;
        try {
          msg = JSON.parse(payload.toString());
        } catch {
          return;
        }
        if (msg.print) {
          merge(this.state, msg.print);
          this.onStatus({ connected: true, ...summarize(this.state) });
        }
      });
    });
  }

  nextSeq() {
    return String(++this.seq);
  }

  publish(body) {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.connected) return reject(new Error('Impressora desconectada.'));
      this.client.publish(`device/${this.cfg.serial}/request`, JSON.stringify(body), { qos: 0 }, (e) => (e ? reject(e) : resolve()));
    });
  }

  requestAll() {
    return this.publish({ pushing: { sequence_id: this.nextSeq(), command: 'pushall' } }).catch(() => {});
  }

  /**
   * Upload a .gcode.3mf to the printer's storage (the microSD card). Tries the
   * storage root first, then /cache. Returns the path where the file landed
   * (relative to the FTP root), which the print command must point to.
   */
  async upload(localFile, remoteName, onProgress = () => {}) {
    const log = (m) => this.log?.(`[ftp] ${m}`);
    const c = new ftp.Client(30000);
    try {
      await c.access({
        host: this.cfg.ip,
        port: this.ftpPort,
        user: 'bblp',
        password: this.cfg.accessCode,
        secure: 'implicit',
        secureOptions: { rejectUnauthorized: false, checkServerIdentity: () => undefined },
      });
      log(`conectado em ${this.cfg.ip}:${this.ftpPort}; cartão (MQTT sdcard) = ${this.state.sdcard}`);
      try {
        const root = await c.list('/');
        log(`raiz: ${root.map((f) => `${f.isDirectory ? 'd' : '-'} ${f.name}`).join(', ') || '(vazia)'}`);
      } catch (e) {
        log(`não consegui listar a raiz: ${e.message}`);
      }
      const total = fs.statSync(localFile).size;
      c.trackProgress((p) => onProgress(Math.min(1, p.bytesOverall / total)));
      let lastError;
      for (const target of [remoteName, `cache/${remoteName}`]) {
        try {
          await c.uploadFrom(fs.createReadStream(localFile), target);
          log(`enviado para /${target} (${total} bytes)`);
          return target;
        } catch (e) {
          lastError = e;
          log(`falhou em /${target}: ${e.message}`);
          // Permission / storage errors: try the next folder. Anything else (network drop) is final.
          if (!/55\d|could not|permission|denied/i.test(String(e?.message))) break;
        }
      }
      throw lastError;
    } catch (e) {
      const msg = String(e?.message || e).replace(/\.+$/, '');
      if (/530|login/i.test(msg) && !/could not/i.test(msg)) throw new Error('Código de acesso incorreto.');
      const noCard = this.state.sdcard === false;
      const hint = noCard
        ? 'A impressora informa que não há cartão microSD. Sem cartão o envio pela rede não funciona.'
        : /55\d|could not/i.test(msg)
          ? 'Isso costuma acontecer quando não há cartão microSD na impressora, ele está cheio ou protegido contra gravação.'
          : '';
      throw new Error(`Falha ao enviar o arquivo: ${msg}. ${hint}`.trim());
    } finally {
      c.close();
    }
  }

  /**
   * Start a print of an already uploaded project.
   * amsMapping[i] = tray id (ams*4+slot, or 254 external) for slicer filament i, or -1.
   */
  startPrint({ remoteName, uploadedAs, plate = 1, amsMapping, useAms = true, bedLevel = true, flowCali = false, timelapse = false }) {
    const mapping = amsMapping ?? [];
    return this.publish({
      print: {
        sequence_id: this.nextSeq(),
        command: 'project_file',
        param: `Metadata/plate_${plate}.gcode`,
        project_id: '0',
        profile_id: '0',
        task_id: '0',
        subtask_id: '0',
        subtask_name: remoteName.replace(/\.gcode\.3mf$|\.3mf$/i, ''),
        url: `ftp://${uploadedAs ?? remoteName}`,
        md5: '',
        timelapse,
        bed_type: 'auto',
        bed_leveling: bedLevel,
        flow_cali: flowCali,
        vibration_cali: true,
        layer_inspect: true,
        use_ams: useAms,
        ams_mapping: mapping,
        ams_mapping2: mapping.map((t) => (t === 254 || t < 0 ? { ams_id: 255, slot_id: 0 } : { ams_id: Math.floor(t / 4), slot_id: t % 4 })),
        skip_objects: null,
      },
    });
  }

  stopPrint() {
    return this.publish({ print: { sequence_id: this.nextSeq(), command: 'stop', param: '' } });
  }
  pausePrint() {
    return this.publish({ print: { sequence_id: this.nextSeq(), command: 'pause', param: '' } });
  }
  resumePrint() {
    return this.publish({ print: { sequence_id: this.nextSeq(), command: 'resume', param: '' } });
  }

  close() {
    clearInterval(this.poll);
    try {
      this.client?.end(true);
    } catch {
      /* already closed */
    }
    this.connected = false;
  }
}

module.exports = { discover, Session, summarize, merge, parseSsdp, MODELS };
