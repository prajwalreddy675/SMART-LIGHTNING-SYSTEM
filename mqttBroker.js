const aedes = require('aedes')();
const net = require('net');

const PORT = 1883;

function startBroker(onMessagePublish, onClientConnect, onClientDisconnect) {
  const server = net.createServer(aedes.handle);
  
  server.listen(PORT, function () {
    console.log(`[MQTT Broker] Embedded MQTT server running on port ${PORT}`);
  });

  // Client connect event
  aedes.on('client', function (client) {
    console.log(`[MQTT Broker] Client Connected: ${client ? client.id : 'unknown'}`);
    if (onClientConnect) {
      onClientConnect(client ? client.id : 'unknown');
    }
  });

  // Client disconnect event
  aedes.on('clientDisconnect', function (client) {
    console.log(`[MQTT Broker] Client Disconnected: ${client ? client.id : 'unknown'}`);
    if (onClientDisconnect) {
      onClientDisconnect(client ? client.id : 'unknown');
    }
  });

  // Message published event
  aedes.on('publish', async function (packet, client) {
    if (client) {
      const topic = packet.topic;
      const payloadString = packet.payload.toString();
      
      // Prevent infinite loops / system topic handling
      if (!topic.startsWith('$SYS')) {
        // console.log(`[MQTT Broker] Published on ${topic} by ${client.id}: ${payloadString}`);
        if (onMessagePublish) {
          onMessagePublish(topic, payloadString, client.id);
        }
      }
    }
  });

  return {
    broker: aedes,
    publish: (topic, payload) => {
      aedes.publish({
        topic: topic,
        payload: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
        qos: 0,
        retain: false
      }, (err) => {
        if (err) console.error('[MQTT Broker] Error publishing packet:', err);
      });
    }
  };
}

module.exports = { startBroker };
