// gt06-server/server.js
//
// Servidor TCP persistente que recibe la conexión directa del módulo
// GT06 (TK806 y compatibles) una vez redirigido con el comando SMS
// "adminip" a este servidor. Reemplaza a mytkstar.net como destino
// de la telemetría del dispositivo.
//
// Corre 24/7 — pensado para Railway, Fly.io, o un VPS pequeño.
// NO funciona como Netlify Function (necesita mantener conexiones TCP abiertas).
//
// Variables de entorno:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   PORT (por defecto 5023, puerto típico GT06 — confirmar el que uses al redirigir el dispositivo)

import net from 'net';
import { createClient } from '@supabase/supabase-js';

// ------------------------------------------------------------
// CRC-ITU (X.25) — el que usa el protocolo GT06 real.
// Implementación completa: ya no es un placeholder.
// ------------------------------------------------------------
function crcItu(buffer) {
  let fcs = 0xFFFF;
  for (const byte of buffer) {
    fcs ^= byte;
    for (let i = 0; i < 8; i++) {
      if (fcs & 0x0001) {
        fcs = (fcs >> 1) ^ 0x8408;
      } else {
        fcs = fcs >> 1;
      }
    }
  }
  fcs = ~fcs & 0xFFFF;
  return Buffer.from([fcs & 0xFF, (fcs >> 8) & 0xFF]); // little-endian, luego se invierte al armar el paquete
}

// El CRC del protocolo GT06 se calcula sobre [longitud + protocolo + datos + serial]
// y se transmite en orden big-endian dentro del paquete.
function crcItuBigEndian(buffer) {
  const le = crcItu(buffer);
  return Buffer.from([le[1], le[0]]);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PORT = process.env.PORT || 5023;

// Protocolos GT06 más comunes (confirmar contra el manual del dispositivo real,
// hay variantes entre fabricantes que usan esta familia de protocolo):
const PROTO = {
  LOGIN: 0x01,
  LOCATION: 0x12,       // GPS + LBS
  LOCATION_ALT: 0x22,   // variante GPS + LBS + status
  HEARTBEAT: 0x13,
  COMMAND_RESPONSE: 0x15,
};

// Conexiones activas, indexadas por IMEI, para poder mandarles comandos
const activeSockets = new Map();

const server = net.createServer((socket) => {
  let imei = null;
  let buffer = Buffer.alloc(0);

  socket.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    // Los paquetes GT06 empiezan con 0x78 0x78 (o 0x79 0x79 para paquetes largos)
    // y terminan con 0x0D 0x0A. Procesamos mientras haya paquetes completos.
    while (buffer.length >= 5) {
      const startOk = buffer[0] === 0x78 && buffer[1] === 0x78;
      if (!startOk) { buffer = buffer.subarray(1); continue; }

      const length = buffer[2]; // longitud del contenido (protocolo + datos + serial + crc)
      const totalLen = 2 + 1 + length + 2; // start(2) + len(1) + content(length) + stop(2)
      if (buffer.length < totalLen) break; // esperar más datos

      const packet = buffer.subarray(0, totalLen);
      buffer = buffer.subarray(totalLen);

      const protocolNumber = packet[3];
      const content = packet.subarray(4, 4 + length - 5); // sin protocolo(1) ni serial(2) ni crc(2)
      const serialNumber = packet.subarray(packet.length - 6, packet.length - 4);

      try {
        if (protocolNumber === PROTO.LOGIN) {
          imei = parseImei(content);
          activeSockets.set(imei, socket);
          console.log(`[login] IMEI ${imei} conectado`);
          sendAck(socket, PROTO.LOGIN, serialNumber);
        }

        else if (protocolNumber === PROTO.LOCATION || protocolNumber === PROTO.LOCATION_ALT) {
          if (!imei) return; // no debería pasar, pero por seguridad
          const loc = parseLocation(content);
          console.log(`[loc] ${imei} -> ${loc.lat}, ${loc.lng} @ ${loc.speedKmh} km/h`);
          await handleTelemetry(imei, loc, socket);
        }

        else if (protocolNumber === PROTO.HEARTBEAT) {
          sendAck(socket, PROTO.HEARTBEAT, serialNumber);
        }
      } catch (err) {
        console.error('Error procesando paquete:', err);
      }
    }
  });

  socket.on('close', () => {
    if (imei) {
      activeSockets.delete(imei);
      console.log(`[close] IMEI ${imei} desconectado`);
    }
  });

  socket.on('error', (err) => console.error('Socket error:', err.message));
});

server.listen(PORT, () => {
  console.log(`Servidor GT06 escuchando en puerto ${PORT}`);
});

// ------------------------------------------------------------
// Lógica de negocio: al recibir telemetría, guardar y decidir corte
// ------------------------------------------------------------
async function handleTelemetry(imei, loc, socket) {
  const { data: vehicle } = await supabase
    .from('vehicles')
    .select('id, cutoff_speed_threshold_kmh')
    .eq('gsm_device_id', imei)
    .maybeSingle();

  if (!vehicle) {
    console.warn(`IMEI ${imei} no está registrado en vehicles`);
    return;
  }

  await supabase.from('vehicle_telemetry').insert({
    vehicle_id: vehicle.id,
    latitude: loc.lat,
    longitude: loc.lng,
    speed_kmh: loc.speedKmh,
  });

  const { data: order } = await supabase
    .from('lock_orders')
    .select('id, status')
    .eq('vehicle_id', vehicle.id)
    .in('status', ['pendiente', 'armada'])
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!order) return;

  const threshold = vehicle.cutoff_speed_threshold_kmh ?? 8;

  if (order.status === 'pendiente') {
    await supabase.from('lock_orders')
      .update({ status: 'armada', speed_at_issue_kmh: loc.speedKmh })
      .eq('id', order.id);
    await supabase.from('lock_order_events').insert({
      order_id: order.id, event_type: 'armada',
      detail: `Confirmada a ${loc.speedKmh} km/h`,
    });
  }

  if (loc.speedKmh <= threshold) {
    console.log(`>>> CORTANDO motor de vehículo ${vehicle.id} (${loc.speedKmh} km/h <= ${threshold})`);
    sendCutCommand(socket);
    await supabase.from('lock_orders')
      .update({ status: 'ejecutada', executed_at: new Date().toISOString() })
      .eq('id', order.id);
    await supabase.from('lock_order_events').insert({
      order_id: order.id, event_type: 'ejecutada',
      detail: `Corte enviado por servidor GT06 a ${loc.speedKmh} km/h`,
    });
  }
}

// ------------------------------------------------------------
// Parsing de paquetes (implementación base — confirmar bytes exactos
// contra la documentación del fabricante del módulo real que uses,
// hay variantes menores entre clones GT06)
// ------------------------------------------------------------
function parseImei(content) {
  // El IMEI viene como 8 bytes BCD (2 dígitos por byte)
  return content.subarray(0, 8).toString('hex').replace(/^0+/, '');
}

function parseLocation(content) {
  // Estructura típica: fecha/hora(6) + satélites(1) + lat(4) + lng(4) +
  // velocidad(1) + curso/estado(2) + ...
  let offset = 6; // saltar fecha/hora
  offset += 1;    // saltar byte de satélites
  const latRaw = content.readUInt32BE(offset); offset += 4;
  const lngRaw = content.readUInt32BE(offset); offset += 4;
  const speedKmh = content.readUInt8(offset); offset += 1;

  return {
    lat: latRaw / 1800000,
    lng: lngRaw / 1800000,
    speedKmh,
  };
}

function sendAck(socket, protocolNumber, serialNumber) {
  const body = Buffer.concat([Buffer.from([0x05]), Buffer.from([protocolNumber]), serialNumber]);
  const crc = crcItuBigEndian(body);
  const packet = Buffer.concat([
    Buffer.from([0x78, 0x78]),
    body,
    crc,
    Buffer.from([0x0D, 0x0A]),
  ]);
  socket.write(packet);
}

function sendCutCommand(socket) {
  // Comando de corte real — encontrado en documentación pública del protocolo
  // GT06/Concox (la misma familia de fabricantes que TKSTAR/TK806), NO 100%
  // confirmado contra el manual específico de TU unidad. Antes de un vehículo
  // real: confirmar contra el manual físico o soporte de Castletec.
  //
  // Hallazgo (documento "Command List", protocolo GT06/Concox):
  //   Comando de corte:     "DY"   → respuesta esperada: "DY OK"
  //   Comando de reactivar: "KY"   → respuesta esperada: "KY OK"
  //   El propio dispositivo trae una capa de seguridad de fábrica: solo
  //   ejecuta el corte si el GPS tiene posición válida Y la velocidad es
  //   menor a 20 km/h (configurable con "SZCS#SOURCE_OFF_TYPE=...").
  //   Esto es una BUENA noticia: significa que aunque nuestra lógica de
  //   servidor falle, el dispositivo mismo rechaza el corte a alta velocidad
  //   como segunda capa de protección (defensa en profundidad).
  const commandText = 'DY'; // ⚠️ candidato fuerte — confirmar contra el manual antes de producción
  const commandBuffer = Buffer.from(commandText, 'ascii');
  const serial = Buffer.from([0x00, 0x01]);
  const body = Buffer.concat([Buffer.from([commandBuffer.length + 5]), Buffer.from([0x80]), commandBuffer, serial]);
  const crc = crcItuBigEndian(body);
  const packet = Buffer.concat([
    Buffer.from([0x78, 0x78]),
    body,
    crc,
    Buffer.from([0x0D, 0x0A]),
  ]);
  socket.write(packet);
}

function sendRestoreCommand(socket) {
  // Comando de reactivación — pareja del comando de corte (ver nota arriba).
  const commandText = 'KY';
  const commandBuffer = Buffer.from(commandText, 'ascii');
  const serial = Buffer.from([0x00, 0x02]);
  const body = Buffer.concat([Buffer.from([commandBuffer.length + 5]), Buffer.from([0x80]), commandBuffer, serial]);
  const crc = crcItuBigEndian(body);
  const packet = Buffer.concat([
    Buffer.from([0x78, 0x78]),
    body,
    crc,
    Buffer.from([0x0D, 0x0A]),
  ]);
  socket.write(packet);
        }

