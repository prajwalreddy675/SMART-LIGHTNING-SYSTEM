/**
 * AI Smart Lighting System with Autonomous Fail-Safe Control
 * Target Device: ESP32 or Arduino with WiFi/BLE + DS3231 RTC
 * 
 * Hardware Layout:
 * - PIR Motion Sensor: Pin 13
 * - LDR Light Sensor: Pin 34 (Analog)
 * - Relay Module: Pin 25
 * - DS3231 RTC: I2C (SDA=Pin 21, SCL=Pin 22 on ESP32)
 * - Status LED: Pin 2 (Onboard LED used for signaling)
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <RTClib.h>
#include <ArduinoJson.h>

// Wi-Fi and MQTT Settings
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";
const char* mqtt_server = "192.168.1.100"; // Update with backend server IP
const int mqtt_port = 1883;

// Pin Declarations
#define PIR_PIN 13
#define LDR_PIN 34
#define RELAY_PIN 25
#define ONBOARD_LED 2

// Hardware objects
RTC_DS3231 rtc;
WiFiClient espClient;
PubSubClient mqttClient(espClient);

// System State Variables
bool lightState = false;
bool motionState = false;
int ldrValue = 0;
String currentTimeStr = "00:00 AM";

// Priority Engine Parameters
enum ControlSource {
  AUTONOMOUS,
  WEBSITE,
  BLUETOOTH
};
ControlSource currentSource = AUTONOMOUS;
bool manualOverrideState = false; // Target state for manual override

// Configurable thresholds
int ldrThreshold = 500;       // Scale: 0 to 4095 for ESP32 ADC (or 0-1023 depending on calibration)
int nightDuration = 30;       // Countdown timer in seconds
unsigned long lastMotionTime = 0;

// Communication & Heartbeat timers
unsigned long lastTelemetryPublish = 0;
const unsigned long telemetryInterval = 3000; // Publish every 3 seconds

// Mock Bluetooth State (if using serial/HC-05 BLE module)
bool bluetoothConnected = false;

// Setup function
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n--- AI Smart Lighting Hub Starting Up ---");

  // Configure Pins
  pinMode(PIR_PIN, INPUT);
  pinMode(LDR_PIN, INPUT);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(ONBOARD_LED, OUTPUT);
  
  digitalWrite(RELAY_PIN, LOW); // Start with light OFF
  digitalWrite(ONBOARD_LED, LOW);

  // Initialize RTC
  if (!rtc.begin()) {
    Serial.println("[RTC ERROR] Couldn't find DS3231 RTC. Using software clock backup.");
  } else if (rtc.lostPower()) {
    Serial.println("[RTC WARNING] RTC lost power, setting compile time!");
    rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
  }

  // Setup Wi-Fi connection
  setupWiFi();

  // Setup MQTT Client
  mqttClient.setServer(mqtt_server, mqtt_port);
  mqttClient.setCallback(mqttCallback);

  Serial.println("System Initialization Complete.");
}

// Loop execution
void loop() {
  // 1. Maintain WiFi and MQTT connection
  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();

  // 2. Read Sensors
  readSensors();

  // 3. Process Bluetooth / Serial commands
  checkBluetoothSerial();

  // 4. Check Connection States & Reset Manual Override if all disconnected
  verifyConnections();

  // 5. Execute Fail-Safe Priority Control Engine
  executePriorityEngine();

  // 6. Periodic Telemetry Publish
  unsigned long now = millis();
  if (now - lastTelemetryPublish > telemetryInterval) {
    lastTelemetryPublish = now;
    publishTelemetry();
  }

  delay(50);
}

// ----------------------------------------------------
// Core Priority Control Engine
// ----------------------------------------------------
void executePriorityEngine() {
  bool finalLightState = false;
  String modeString = "";
  String sourceString = "";

  // PRIORITY LEVEL 1: MANUAL CONTROL (Website or Bluetooth overrides)
  if (currentSource == WEBSITE || currentSource == BLUETOOTH) {
    finalLightState = manualOverrideState;
    
    if (currentSource == WEBSITE) {
      sourceString = "Website Control Active";
      modeString = manualOverrideState ? "Manual Override ON" : "Manual Override OFF";
    } else {
      sourceString = "Bluetooth Control Active";
      modeString = manualOverrideState ? "Manual Override ON" : "Manual Override OFF";
    }
  } 
  // PRIORITY LEVEL 2: AUTONOMOUS SMART MODE
  else {
    sourceString = "Autonomous Control";
    
    // Read RTC Time (Format check)
    DateTime now = rtc.now();
    int hour = now.hour();
    bool isDayTime = (hour >= 6 && hour < 18); // Daytime is 06:00 AM to 06:00 PM

    // Condition 1: Day Mode Logic
    // Day time (06:00 AM - 06:00 PM) AND Ambient brightness above threshold
    if (isDayTime && ldrValue >= ldrThreshold) {
      finalLightState = false; // Keep light OFF due to daylight
      modeString = "Daytime Energy Saving";
    } 
    // Condition 2: Night Mode Logic
    // Night time (06:00 PM - 06:00 AM) OR Ambient brightness below threshold (e.g. cloudy/dark room)
    else {
      modeString = "Autonomous Night Mode Active";
      
      if (motionState) {
        finalLightState = true; // Turn ON
        lastMotionTime = millis(); // Refresh countdown
      } else {
        // Countdown timer check (converted nightDuration to milliseconds)
        unsigned long elapsedSinceMotion = (millis() - lastMotionTime) / 1000;
        if (elapsedSinceMotion < nightDuration) {
          finalLightState = true; // Stay ON during the timeout period
        } else {
          finalLightState = false; // Turn OFF after timeout
        }
      }
    }
  }

  // Actuate Hardware Relay
  if (lightState != finalLightState) {
    lightState = finalLightState;
    digitalWrite(RELAY_PIN, lightState ? HIGH : LOW);
    digitalWrite(ONBOARD_LED, lightState ? HIGH : LOW); // Mirror on status LED
    
    Serial.print("[Relay Event] Light turned ");
    Serial.println(lightState ? "ON" : "OFF");
    
    // Publish change instantly
    publishTelemetry();
    publishEvent("relay_toggle", "Light switched " + String(lightState ? "ON" : "OFF") + " by " + sourceString, sourceString);
  }
}

// ----------------------------------------------------
// Sensor Processing
// ----------------------------------------------------
void readSensors() {
  // Read PIR Motion Sensor
  motionState = (digitalRead(PIR_PIN) == HIGH);

  // Read LDR (Analog Reading: 0 to 4095 on ESP32, convert to 0-1023 scale for backend alignment)
  int rawLdr = analogRead(LDR_PIN);
  ldrValue = map(rawLdr, 0, 4095, 0, 1023);

  // Read Clock from RTC
  if (rtc.begin()) {
    DateTime now = rtc.now();
    char buffer[12];
    int displayHour = now.hour() % 12;
    if (displayHour == 0) displayHour = 12;
    snprintf(buffer, sizeof(buffer), "%02d:%02d %s", 
             displayHour, 
             now.minute(), 
             now.hour() >= 12 ? "PM" : "AM");
    currentTimeStr = String(buffer);
  } else {
    currentTimeStr = "12:00 PM (Sim)";
  }
}

// ----------------------------------------------------
// Connection Health Monitors
// ----------------------------------------------------
void verifyConnections() {
  bool isConnected = (WiFi.status() == WL_CONNECTED && mqttClient.connected());
  
  // Fail-Safe Reset:
  // If connections drop and we lose manual inputs, fall back immediately to Autonomous
  if (!isConnected && !bluetoothConnected && currentSource != AUTONOMOUS) {
    Serial.println("[Fail-Safe Engine] All manual connections lost. Reverting to Autonomous Smart Mode.");
    currentSource = AUTONOMOUS;
    publishEvent("failsafe_fallback", "Manual connections lost. Reverting to Autonomous Mode.", "Autonomous");
  }
}

// ----------------------------------------------------
// Wi-Fi & MQTT Client Operations
// ----------------------------------------------------
void setupWiFi() {
  delay(10);
  Serial.print("[WiFi] Connecting to ");
  Serial.println(ssid);
  
  WiFi.begin(ssid, password);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 15) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] Connected! IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n[WiFi ERROR] Failed to connect to Wi-Fi. Entering Standalone Mode.");
  }
}

void reconnectMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;
  
  int attempts = 0;
  while (!mqttClient.connected() && attempts < 3) {
    Serial.print("[MQTT] Attempting connection to broker...");
    String clientId = "esp32-light-hub-" + String(random(0xffff), HEX);
    
    // Attempt to connect with a Last Will and Testament to set status Offline on crash
    if (mqttClient.connect(clientId.c_str(), "hub/light/status", 0, true, "offline")) {
      Serial.println("connected!");
      
      // Publish online event
      mqttClient.publish("hub/light/status", "online", true);
      
      // Subscribe to control topics
      mqttClient.subscribe("hub/light/control");
      mqttClient.subscribe("hub/light/config");
    } else {
      Serial.print("failed, rc=");
      Serial.print(mqttClient.state());
      Serial.println(" try again in 3 seconds");
      delay(3000);
      attempts++;
    }
  }
}

// MQTT Callback when a message is received from the Server/Website
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  
  Serial.print("[MQTT Recv] Topic: ");
  Serial.print(topic);
  Serial.print(" Payload: ");
  Serial.println(message);

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) {
    Serial.println("[JSON ERROR] Failed to parse payload");
    return;
  }

  // 1. Handle Light Overrides
  if (strcmp(topic, "hub/light/control") == 0) {
    String state = doc["state"];     // "ON" | "OFF" | "AUTO"
    String source = doc["source"];   // "Website" | "Bluetooth"

    if (state == "AUTO") {
      currentSource = AUTONOMOUS;
      Serial.println("[Command] Returned to Autonomous mode.");
    } else {
      currentSource = (source == "Bluetooth") ? BLUETOOTH : WEBSITE;
      manualOverrideState = (state == "ON");
      Serial.print("[Command] Manual override: ");
      Serial.println(manualOverrideState ? "ON" : "OFF");
    }
  }
  // 2. Handle Configurations
  else if (strcmp(topic, "hub/light/config") == 0) {
    if (doc.containsKey("ldrThreshold")) {
      ldrThreshold = doc["ldrThreshold"];
      Serial.print("[Config] Updated LDR threshold to: ");
      Serial.println(ldrThreshold);
    }
    if (doc.containsKey("nightDuration")) {
      nightDuration = doc["nightDuration"];
      Serial.print("[Config] Updated Night light duration to: ");
      Serial.println(nightDuration);
    }
  }
}

// ----------------------------------------------------
// Bluetooth / HC-05 Serial Parser
// ----------------------------------------------------
void checkBluetoothSerial() {
  // HC-05 is typically connected via HardwareSerial (Serial1 or Serial2) or SoftwareSerial.
  // We check standard Serial connection or custom incoming buffer for simulation
  if (Serial.available() > 0) {
    String incomingStr = Serial.readStringUntil('\n');
    incomingStr.trim();
    
    if (incomingStr.length() == 0) return;

    Serial.print("[Bluetooth Recv] Data: ");
    Serial.println(incomingStr);

    // Command parser for Bluetooth app control
    // Expected command formats: "BT_ON", "BT_OFF", "BT_AUTO", "BT_CONNECT", "BT_DISCONNECT"
    if (incomingStr == "BT_CONNECT") {
      bluetoothConnected = true;
      Serial.println("[Bluetooth] Client Device Connected.");
      publishEvent("bluetooth_connected", "Mobile app connected via Bluetooth", "Bluetooth");
    }
    else if (incomingStr == "BT_DISCONNECT") {
      bluetoothConnected = false;
      Serial.println("[Bluetooth] Client Device Disconnected.");
      if (currentSource == BLUETOOTH) {
        currentSource = AUTONOMOUS;
      }
      publishEvent("bluetooth_disconnected", "Mobile app disconnected from Bluetooth", "Bluetooth");
    }
    else if (incomingStr == "BT_ON") {
      currentSource = BLUETOOTH;
      manualOverrideState = true;
      Serial.println("[Bluetooth] Light set to Manual ON");
      publishEvent("bluetooth_manual", "Bluetooth manual override active: Turn ON", "Bluetooth");
    }
    else if (incomingStr == "BT_OFF") {
      currentSource = BLUETOOTH;
      manualOverrideState = false;
      Serial.println("[Bluetooth] Light set to Manual OFF");
      publishEvent("bluetooth_manual", "Bluetooth manual override active: Turn OFF", "Bluetooth");
    }
    else if (incomingStr == "BT_AUTO") {
      currentSource = AUTONOMOUS;
      Serial.println("[Bluetooth] Return to Autonomous Smart Mode");
      publishEvent("bluetooth_auto", "Bluetooth returned system to Autonomous Mode", "Bluetooth");
    }
  }
}

// ----------------------------------------------------
// Telemetry and Event Senders
// ----------------------------------------------------
void publishTelemetry() {
  if (!mqttClient.connected()) return;

  JsonDocument doc;
  doc["ldr"] = ldrValue;
  doc["motion"] = motionState;
  doc["state"] = lightState ? "ON" : "OFF";
  doc["rtc"] = currentTimeStr;
  doc["power"] = lightState ? 40 : 5; // 40W active bulb, 5W standby electronics
  
  // Mode logic descriptor
  if (currentSource == WEBSITE) {
    doc["mode"] = "Manual Override ON/OFF";
    doc["source"] = "Website Control Active";
  } else if (currentSource == BLUETOOTH) {
    doc["mode"] = "Manual Override ON/OFF";
    doc["source"] = "Bluetooth Control Active";
  } else {
    DateTime now = rtc.now();
    bool isDayTime = (now.hour() >= 6 && now.hour() < 18);
    if (isDayTime && ldrValue >= ldrThreshold) {
      doc["mode"] = "Daytime Energy Saving";
    } else {
      doc["mode"] = "Autonomous Night Mode Active";
    }
    doc["source"] = "Autonomous Smart Mode Active";
  }

  char buffer[256];
  serializeJson(doc, buffer);
  mqttClient.publish("hub/light/telemetry", buffer);
}

void publishEvent(String type, String message, String source) {
  if (!mqttClient.connected()) return;

  JsonDocument doc;
  doc["type"] = type;
  doc["message"] = message;
  doc["source"] = source;

  char buffer[256];
  serializeJson(doc, buffer);
  mqttClient.publish("hub/light/event", buffer);
}
