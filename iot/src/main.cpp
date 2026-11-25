// DriveAlert AI — boîtier d'alerte (ESP32, simulé dans Wokwi)
//
// Les messages de la plateforme arrivent par MQTT (broker public HiveMQ) :
//   drivealert/pfa-alae-01/alerte     <- {"niveau":3,"cause":"Yeux fermes 2.1 s","lat":33.57,"lon":-7.58}
//   drivealert/pfa-alae-01/heartbeat  <- même format, toutes les 2 s (signe de vie + niveau courant)
//   drivealert/pfa-alae-01/ack        -> le conducteur a appuyé sur le bouton
//   drivealert/pfa-alae-01/journal    -> chaque événement du journal
//   drivealert/pfa-alae-01/etat       -> {"enLigne":true|false} (retenu ; « false » publié par le broker si le boîtier tombe)
//
// Secours : les mêmes commandes peuvent être tapées dans le moniteur série.
//   0 / 1 / 2 / 3                      -> niveau d'alerte
//   {"niveau":2,"cause":"Yeux fermes"} -> niveau + cause affichée sur l'écran
//   hb                                 -> signe de vie de la plateforme (heartbeat)
//   journal / effacer / aide           -> lire ou vider le journal, afficher l'aide
//
// Niveau 0 : LED verte, « Conduite normale »
// Niveau 1 : LED orange, un bip court
// Niveau 2 : LED rouge clignotante, bip chaque seconde, vibration
// Niveau 3 : LED rouge rapide, bips continus, vibration, relais (feux de détresse)
// Bouton   : « J'ai vu » -> coupe le son et la vibration, ou valide le rappel de pause.
//
// En plus : auto-test au démarrage, LED « Connexion », rappel de pause,
// journal des alertes sur carte microSD (copie en mémoire si la carte est absente),
// SOS WhatsApp (Green-API) si le conducteur ne répond pas 10 s à une alerte de niveau 3.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <LiquidCrystal_I2C.h>
#include <PubSubClient.h>
#include <SD.h>
#include <SPI.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <time.h>

// Identifiants Green-API et numéro : dans include/secrets.h (ignoré par git).
#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

namespace pin {
constexpr uint8_t LED_VERTE = 25;
constexpr uint8_t LED_ORANGE = 26;
constexpr uint8_t LED_ROUGE = 27;
constexpr uint8_t LED_CONNEXION = 32;
constexpr uint8_t VIBRATION = 19;  // Wokwi n'a pas de moteur vibrant : LED bleue à la place
constexpr uint8_t BUZZER = 18;
constexpr uint8_t RELAIS = 23;
constexpr uint8_t BOUTON = 4;  // vers GND, pull-up interne
// Carte microSD (bus SPI déplacé : les broches SPI par défaut sont déjà utilisées)
constexpr uint8_t SD_SCK = 14;
constexpr uint8_t SD_MISO = 33;
constexpr uint8_t SD_MOSI = 13;
constexpr uint8_t SD_CS = 5;
}  // namespace pin

// ---- Réglages ----
constexpr unsigned long DUREE_AVANT_PAUSE_MS = 20UL * 1000;  // TEST : 20 s (réel : 2UL * 60 * 60 * 1000 = 2 h)
constexpr unsigned long DUREE_RAPPEL_PAUSE_MS = 10UL * 1000;  // le rappel dure 10 s : bouton = accepter, rien = annulé
constexpr unsigned long DELAI_SOS_MS = 10UL * 1000;           // niveau 3 sans réponse pendant 10 s -> SOS
constexpr unsigned long RAPPEL_SOS_MS = 2UL * 60 * 1000;      // toujours sans réponse : rappel toutes les 2 min
constexpr unsigned long NOUVEL_ESSAI_SOS_MS = 30UL * 1000;    // envoi raté : on réessaie après 30 s
constexpr unsigned long DELAI_CONNEXION_MS = 5000;         // plus de signe de vie depuis 5 s = déconnecté
const char* FICHIER_JOURNAL = "/journal.csv";

// MQTT : broker public gratuit. Le préfixe contient un identifiant unique du boîtier
// pour ne pas se mélanger avec les autres utilisateurs du broker.
const char* MQTT_HOTE = "broker.hivemq.com";
constexpr uint16_t MQTT_PORT = 1883;
const char* PREFIXE = "drivealert/pfa-alae-01/";
constexpr unsigned long DELAI_RECONNEXION_MQTT_MS = 3000;

LiquidCrystal_I2C lcd(0x27, 16, 2);
SPIClass spiSD(HSPI);

// ---- État ----
int niveau = 0;
String cause;
bool acquitte = false;          // le conducteur a appuyé sur le bouton pendant l'alerte
unsigned long debutNiveau = 0;  // millis() au dernier changement de niveau

bool pauseActive = false;
unsigned long debutConduite = 0;  // départ du compteur de conduite (remis à zéro après une pause)
unsigned long debutPause = 0;
String messageTemporaire;  // confirmation affichée 2 s (« Bonne pause ! », « Pause annulee »)
unsigned long finMessage = 0;

bool jamaisConnecte = true;
bool connecte = false;
unsigned long dernierSigneDeVie = 0;

bool sdOk = false;

bool sosEnvoye = false;           // un SOS est parti pour l'alerte en cours
unsigned long dernierSos = 0;     // millis() du dernier SOS envoyé
unsigned long prochainEssaiSos = 0;
bool wifiConnecte = false;

WiFiClient clientReseau;
PubSubClient mqtt(clientReseau);
bool mqttConnecte = false;

// Position envoyée dans le SOS : simulée par défaut, remplacée par celle du navigateur si la plateforme la partage.
String positionLat = POSITION_LAT, positionLon = POSITION_LON;

String topic(const char* nom) { return String(PREFIXE) + nom; }

/** Publie un document JSON sur drivealert/pfa-alae-01/<nom> (si MQTT est connecté). */
void publier(const char* nom, JsonDocument& doc, bool retenu = false) {
  if (!mqtt.connected()) return;
  String json;
  serializeJson(doc, json);
  mqtt.publish(topic(nom).c_str(), json.c_str(), retenu);
}

/** Sans identifiants Green-API dans secrets.h, le SOS est simulé (affiché dans le moniteur série). */
bool sosSimule() { return strlen(GREENAPI_URL) == 0 || strlen(GREENAPI_ID_INSTANCE) == 0 || strlen(GREENAPI_TOKEN) == 0; }


// =====================================================================
// Journal des alertes : « temps;evenement;niveau;detail »
// =====================================================================
constexpr int TAILLE_JOURNAL_RAM = 40;
String journalRam[TAILLE_JOURNAL_RAM];
int journalDebut = 0, journalTaille = 0;

/** Temps depuis le démarrage, « h:mm:ss » (pas d'horloge réelle avant l'étape 2). */
String duree(unsigned long ms) {
  unsigned long s = ms / 1000;
  char b[16];
  snprintf(b, sizeof b, "%lu:%02lu:%02lu", s / 3600, (s / 60) % 60, s % 60);
  return b;
}

/** Heure réelle (NTP, heure du Maroc) dès que le Wi-Fi l'a donnée, sinon temps depuis l'allumage. */
String horodatage() {
  time_t maintenant = time(nullptr);
  if (maintenant < 1700000000) return "+" + duree(millis());  // horloge pas encore réglée
  char b[24];
  strftime(b, sizeof b, "%d/%m/%Y %H:%M:%S", localtime(&maintenant));
  return b;
}

void journaliser(const char* evenement, int niv, String detail = "") {
  detail.replace(";", ",");
  String ligne = horodatage() + ";" + evenement + ";" + niv + ";" + detail;

  journalRam[(journalDebut + journalTaille) % TAILLE_JOURNAL_RAM] = ligne;
  if (journalTaille < TAILLE_JOURNAL_RAM) journalTaille++;
  else journalDebut = (journalDebut + 1) % TAILLE_JOURNAL_RAM;

  if (sdOk) {
    File f = SD.open(FICHIER_JOURNAL, FILE_APPEND);
    if (f) {
      f.println(ligne);
      f.close();
    }
  }
  Serial.printf("[journal] %s\n", ligne.c_str());

  JsonDocument doc;  // copie envoyée à la plateforme
  doc["temps"] = horodatage();
  doc["evenement"] = evenement;
  doc["niveau"] = niv;
  doc["detail"] = detail;
  publier("journal", doc);
}

void creerEnTeteJournal() {
  File f = SD.open(FICHIER_JOURNAL, FILE_WRITE);
  if (f) {
    f.println("temps;evenement;niveau;detail");
    f.close();
  }
}

void afficherJournal() {
  Serial.println("----- journal des alertes -----");
  if (sdOk) {
    File f = SD.open(FICHIER_JOURNAL, FILE_READ);
    while (f && f.available()) Serial.write(f.read());
    if (f) f.close();
  } else {
    Serial.println("(carte SD absente : dernieres entrees en memoire)");
    for (int i = 0; i < journalTaille; i++) Serial.println(journalRam[(journalDebut + i) % TAILLE_JOURNAL_RAM]);
  }
  Serial.println("-------------------------------");
}

void effacerJournal() {
  journalDebut = journalTaille = 0;
  if (sdOk) {
    SD.remove(FICHIER_JOURNAL);
    creerEnTeteJournal();
  }
  Serial.println("Journal efface.");
}

// =====================================================================
// Écran : on ne réécrit que si le texte change (évite le scintillement)
// =====================================================================
String ligne1Affichee, ligne2Affichee;

void afficher(const String& l1, const String& l2) {
  if (l1 == ligne1Affichee && l2 == ligne2Affichee) return;
  ligne1Affichee = l1;
  ligne2Affichee = l2;
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(l1.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(l2.substring(0, 16));
}

/** L'écran LCD ne connaît pas les accents : « Yeux fermés » -> « Yeux fermes ». */
String sansAccents(String s) {
  const char* paires[][2] = {{"é", "e"}, {"è", "e"}, {"ê", "e"}, {"ë", "e"}, {"à", "a"}, {"â", "a"},
                             {"î", "i"}, {"ï", "i"}, {"ô", "o"}, {"ù", "u"}, {"û", "u"}, {"ç", "c"},
                             {"É", "E"}, {"È", "E"}, {"À", "A"}, {"Ç", "C"}};
  for (auto& p : paires) s.replace(p[0], p[1]);
  String propre;
  for (size_t i = 0; i < s.length(); i++)
    if ((uint8_t)s[i] < 128) propre += s[i];
  return propre;
}

void majEcran() {
  if (pauseActive) {
    unsigned long reste = (DUREE_RAPPEL_PAUSE_MS - (millis() - debutPause) + 999) / 1000;
    afficher("PAUSE CONSEILLEE", "Bouton = OK " + String(reste) + "s");
    return;
  }
  if (niveau == 0 && millis() < finMessage) {
    afficher("Conduite normale", messageTemporaire);
    return;
  }
  if (niveau == 0 && !jamaisConnecte && !connecte) {  // plus de heartbeat : on le signale au conducteur
    afficher("Plateforme", "DECONNECTEE");
    return;
  }
  static const char* titres[] = {"Conduite normale", "VIGILANCE", "!! ALERTE !!", "DANGER-ARRETEZ!"};
  static const char* defauts[] = {"DriveAlert AI", "Pensez a 1 pause", "Reveillez-vous", "Arretez-vous"};
  String l2 = acquitte ? String("Alerte vue : OK")
                       : (niveau > 0 && cause.length() ? sansAccents(cause) : String(defauts[niveau]));
  if (niveau == 3 && !acquitte) {  // décompte avant l'envoi du SOS
    unsigned long ecoule = millis() - debutNiveau;
    l2 = sosEnvoye ? String(sosSimule() ? "SOS ENVOYE (sim)" : "SOS ENVOYE")
         : ecoule < DELAI_SOS_MS ? "SOS dans " + String((DELAI_SOS_MS - ecoule + 999) / 1000) + "s"
                                 : String("SOS en cours...");
  }
  afficher(titres[niveau], l2);
}

// =====================================================================
// Messages reçus
// =====================================================================
void signeDeVie() { dernierSigneDeVie = millis(), jamaisConnecte = false; }

void appliquerNiveau(int n, const String& c) {
  if (n < 0 || n > 3) {
    Serial.printf("Niveau invalide : %d (attendu 0 a 3)\n", n);
    return;
  }
  cause = c;
  if (n != niveau) {
    niveau = n;
    acquitte = false;
    debutNiveau = millis();
    journaliser("NIVEAU", niveau, cause);
  }
}

/** Message de la plateforme : {"niveau":N,"cause":"...","lat":..,"lon":..} (alerte ou heartbeat). */
void traiterMessage(JsonDocument& doc) {
  if (doc["lat"].is<float>() && doc["lon"].is<float>()) {
    positionLat = String(doc["lat"].as<float>(), 5);
    positionLon = String(doc["lon"].as<float>(), 5);
  }
  if (doc["niveau"].is<int>()) appliquerNiveau(doc["niveau"].as<int>(), String(doc["cause"] | ""));
}

void aide() {
  Serial.println("Commandes : 0 1 2 3 | {\"niveau\":N,\"cause\":\"...\"} | hb | journal | effacer | aide");
}

void traiterLigne(String ligne) {
  ligne.trim();
  if (ligne.isEmpty()) return;
  signeDeVie();  // tout message de la plateforme prouve qu'elle est là
  if (ligne == "hb") return;
  Serial.printf("> recu : %s\n", ligne.c_str());

  if (ligne[0] == '{') {
    JsonDocument doc;
    if (deserializeJson(doc, ligne)) {
      Serial.println("JSON invalide");
      return;
    }
    traiterMessage(doc);
  } else if (ligne.length() == 1 && isDigit(ligne[0])) {
    appliquerNiveau(ligne[0] - '0', "");
  } else if (ligne == "journal") {
    afficherJournal();
  } else if (ligne == "effacer") {
    effacerJournal();
  } else {
    aide();
  }
}

void lireSerie() {
  static String tampon;
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') {  // Wokwi (VS Code) envoie \r, d'autres terminaux \n
      traiterLigne(tampon);
      tampon = "";
    } else if (tampon.length() < 200) {
      tampon += ch;
    }
  }
}

// =====================================================================
// Bouton « J'ai vu » (anti-rebond 30 ms)
// =====================================================================
/** Prévient la plateforme que le conducteur a appuyé sur le bouton. */
void publierAck(const char* type) {
  JsonDocument doc;
  doc["type"] = type;  // "alerte" ou "pause"
  doc["niveau"] = niveau;
  doc["temps"] = horodatage();
  publier("ack", doc);
}

void appuiBouton() {
  if (pauseActive) {  // le conducteur accepte la pause
    pauseActive = false;
    debutConduite = millis();
    messageTemporaire = "Bonne pause !";
    finMessage = millis() + 2000;
    journaliser("PAUSE_OK", niveau, "pause acceptee par le conducteur");
    publierAck("pause");
  } else if (niveau > 0 && !acquitte) {
    acquitte = true;
    journaliser("ACK", niveau, "alerte vue par le conducteur");
    publierAck("alerte");
  }
}

void lireBouton() {
  static bool etatStable = HIGH, dernierEtat = HIGH;
  static unsigned long dernierChangement = 0;
  bool lu = digitalRead(pin::BOUTON);
  if (lu != dernierEtat) {
    dernierEtat = lu;
    dernierChangement = millis();
  }
  if (millis() - dernierChangement > 30 && lu != etatStable) {
    etatStable = lu;
    if (etatStable == LOW) appuiBouton();
  }
}

// =====================================================================
// Rappel de pause et connexion
// =====================================================================
void majPause() {
  unsigned long maintenant = millis();
  if (pauseActive) {
    if (niveau > 0) {  // la somnolence passe avant : on oublie le rappel de pause
      pauseActive = false;
      debutConduite = maintenant;
      journaliser("PAUSE_ANNULEE", niveau, "somnolence detectee");
    } else if (maintenant - debutPause >= DUREE_RAPPEL_PAUSE_MS) {  // 10 s sans réponse : annulé
      pauseActive = false;
      debutConduite = maintenant;
      messageTemporaire = "Pause annulee";
      finMessage = maintenant + 2000;
      journaliser("PAUSE_ANNULEE", niveau, "pas de reponse en 10 s");
    }
    return;
  }
  if (niveau == 0 && maintenant - debutConduite >= DUREE_AVANT_PAUSE_MS) {
    pauseActive = true;
    debutPause = maintenant;
    journaliser("PAUSE_RAPPEL", 0, "conduite " + duree(maintenant - debutConduite));
  }
}

void majConnexion() {
  bool maintenant = !jamaisConnecte && millis() - dernierSigneDeVie < DELAI_CONNEXION_MS;
  if (maintenant != connecte) {
    connecte = maintenant;
    journaliser(connecte ? "CONNEXION" : "DECONNEXION", niveau, connecte ? "plateforme en ligne" : "plus de signe de vie");
  }
}

// =====================================================================
// Wi-Fi (sert à l'heure réelle et au SOS WhatsApp)
// =====================================================================
void demarrerWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_MOTDEPASSE, 6);  // canal 6 : connexion plus rapide dans Wokwi
  configTzTime("<+01>-1", "pool.ntp.org", "time.google.com");  // heure du Maroc (UTC+1)
}

void majWifi() {
  bool maintenant = WiFi.status() == WL_CONNECTED;
  if (maintenant != wifiConnecte) {
    wifiConnecte = maintenant;
    journaliser(wifiConnecte ? "WIFI_OK" : "WIFI_PERDU", niveau, wifiConnecte ? WiFi.localIP().toString() : "");
    if (!wifiConnecte) WiFi.reconnect();
  }
}

// =====================================================================
// MQTT : reçoit les alertes de la plateforme, envoie ack / journal / état
// =====================================================================
void recevoirMqtt(char* nomTopic, byte* contenu, unsigned int taille) {
  String texte;  // copie : le tampon de PubSubClient est réutilisé par publish()
  for (unsigned int i = 0; i < taille; i++) texte += (char)contenu[i];
  signeDeVie();  // alerte ou heartbeat : la plateforme est là

  JsonDocument doc;
  if (deserializeJson(doc, texte)) {
    Serial.printf("MQTT : JSON invalide sur %s\n", nomTopic);
    return;
  }
  traiterMessage(doc);
}

void majMqtt() {
  static unsigned long dernierEssai = 0;
  if (mqtt.connected()) {
    mqtt.loop();
    return;
  }
  if (mqttConnecte) {
    mqttConnecte = false;
    journaliser("MQTT_PERDU", niveau, "connexion au broker perdue");
  }
  if (!wifiConnecte || millis() - dernierEssai < DELAI_RECONNEXION_MQTT_MS) return;
  dernierEssai = millis();

  String id = "drivealert-esp32-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  String topicEtat = topic("etat");
  // « Testament » (LWT) : si le boîtier disparaît, le broker publie lui-même enLigne:false.
  if (!mqtt.connect(id.c_str(), nullptr, nullptr, topicEtat.c_str(), 1, true, "{\"enLigne\":false}")) {
    Serial.printf("MQTT : connexion impossible (code %d), nouvel essai dans 3 s\n", mqtt.state());
    return;
  }
  mqttConnecte = true;
  mqtt.subscribe(topic("alerte").c_str());
  mqtt.subscribe(topic("heartbeat").c_str());

  JsonDocument etat;
  etat["enLigne"] = true;
  etat["ip"] = WiFi.localIP().toString();
  etat["sos"] = sosSimule() ? "simulation" : "whatsapp";
  publier("etat", etat, true);
  journaliser("MQTT_OK", niveau, MQTT_HOTE);
}

// =====================================================================
// SOS WhatsApp (Green-API) : niveau 3 sans réponse pendant 10 s
// =====================================================================
/** Appelle une méthode Green-API (sendMessage, sendLocation...). Ne journalise jamais l'URL (elle contient le jeton). */
bool appelGreenApi(const char* methode, JsonDocument& corps) {
  corps["chatId"] = String(WHATSAPP_NUMERO) + "@c.us";
  String json;
  serializeJson(corps, json);

  WiFiClientSecure client;
  client.setInsecure();  // simplification pour le PFA : pas de vérification du certificat
  HTTPClient http;
  http.setTimeout(10000);
  String url = String(GREENAPI_URL) + "/waInstance" + GREENAPI_ID_INSTANCE + "/" + methode + "/" + GREENAPI_TOKEN;
  if (!http.begin(client, url)) {
    journaliser("SOS_ECHEC", niveau, "connexion a Green-API impossible");
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(json);
  http.end();
  if (code != 200) {
    journaliser("SOS_ECHEC", niveau, String(methode) + " : reponse Green-API " + code);
    return false;
  }
  return true;
}

/** Envoie un message WhatsApp (et, si demandé, la position sous forme de carte). */
bool envoyerWhatsApp(const String& texte, bool avecPosition = false) {
  Serial.println("----- message WhatsApp -----");
  Serial.println(texte);
  Serial.println("----------------------------");

  if (sosSimule()) return true;  // pas d'identifiants : le message est seulement affiché ci-dessus
  if (!wifiConnecte) {
    journaliser("SOS_ECHEC", niveau, "pas de Wi-Fi");
    return false;
  }
  afficher("SOS...", "Envoi WhatsApp");

  JsonDocument message;
  message["message"] = texte;
  if (!appelGreenApi("sendMessage", message)) return false;

  if (avecPosition) {  // carte WhatsApp cliquable (un échec ici n'annule pas le SOS déjà parti)
    JsonDocument position;
    position["latitude"] = positionLat.toFloat();
    position["longitude"] = positionLon.toFloat();
    position["nameLocation"] = "Position du conducteur";
    position["address"] = "DriveAlert AI - SOS";
    appelGreenApi("sendLocation", position);
  }
  return true;
}

String messageSos(bool rappel) {
  String m = rappel ? "🔁 *RAPPEL – DriveAlert AI – URGENCE*\n" : "🚨 *DriveAlert AI – URGENCE*\n";
  m += "Le conducteur ne répond pas à une alerte de somnolence grave";
  m += rappel ? " (toujours aucune réponse).\n" : " depuis 10 s.\n";
  if (cause.length()) m += "Cause : " + cause + "\n";
  m += "Heure : " + horodatage() + "\n";
  m += String("📍 Position : https://maps.google.com/?q=") + positionLat + "," + positionLon + "\n";
  m += "Appelez-le. Sans réponse, appelez les secours : 15 (protection civile), 19 (police), "
       "177 (gendarmerie), 112.";
  return m;
}

void majSos() {
  unsigned long maintenant = millis();
  bool urgence = niveau == 3 && !acquitte;

  if (sosEnvoye && !urgence) {  // fin de l'urgence : on rassure les proches
    sosEnvoye = false;
    String fin = acquitte ? "✅ *DriveAlert AI* : le conducteur a répondu à l'alerte. Il va bien."
                          : "ℹ️ *DriveAlert AI* : l'alerte grave est terminée (niveau " + String(niveau) + ").";
    envoyerWhatsApp(fin);
    journaliser("SOS_FIN", niveau, acquitte ? "le conducteur a repondu" : "niveau redescendu");
    return;
  }
  if (!urgence) {
    prochainEssaiSos = 0;
    return;
  }
  if (maintenant - debutNiveau < DELAI_SOS_MS) return;  // décompte en cours : le conducteur peut encore répondre

  if (!sosEnvoye) {
    if (maintenant < prochainEssaiSos) return;
    if (envoyerWhatsApp(messageSos(false), true)) {
      sosEnvoye = true;
      dernierSos = maintenant;
      journaliser("SOS_ENVOYE", niveau, sosSimule() ? "simule (Green-API non configure)" : "WhatsApp envoye");
    } else {
      prochainEssaiSos = maintenant + NOUVEL_ESSAI_SOS_MS;
    }
  } else if (maintenant - dernierSos >= RAPPEL_SOS_MS) {
    dernierSos = maintenant;
    if (envoyerWhatsApp(messageSos(true), true)) journaliser("SOS_RAPPEL", niveau, sosSimule() ? "simule" : "WhatsApp envoye");
  }
}

// =====================================================================
// Actionneurs : motifs calculés à partir du temps
// =====================================================================
void majSorties() {
  unsigned long t = millis() - debutNiveau;
  bool orange = niveau == 1, rouge = false, vibre = false, bip = false;
  unsigned int frequence = 2000;

  switch (niveau) {
    case 1:
      bip = t < 150;  // un seul bip court
      break;
    case 2:
      rouge = (t % 1000) < 500;
      bip = (t % 1000) < 200;
      vibre = (t % 1000) < 300;
      frequence = 2500;
      break;
    case 3:
      rouge = (t % 200) < 100;
      bip = (t % 250) < 150;
      vibre = (t % 400) < 300;
      frequence = 3000;
      break;
  }
  if (acquitte) bip = vibre = false;  // les LED et le relais restent, le bruit s'arrête

  if (pauseActive) {  // orange clignotant + double bip doux toutes les 3 s
    unsigned long tp = (millis() - debutPause) % 3000;
    orange = (millis() - debutPause) % 1000 < 500;
    bip = tp < 120 || (tp >= 240 && tp < 360);
    frequence = 1500;
  }

  digitalWrite(pin::LED_VERTE, niveau == 0 && !pauseActive);
  digitalWrite(pin::LED_ORANGE, orange);
  digitalWrite(pin::LED_ROUGE, rouge);
  digitalWrite(pin::VIBRATION, vibre);
  digitalWrite(pin::RELAIS, niveau == 3);
  // Connexion : fixe = plateforme en ligne, clignotement bref = pas de signe de vie
  digitalWrite(pin::LED_CONNEXION, connecte || millis() % 1000 < 100);

  static bool bipActif = false;
  static unsigned int frequenceActive = 0;
  if (bip != bipActif || (bip && frequence != frequenceActive)) {
    bipActif = bip;
    frequenceActive = frequence;
    if (bip) tone(pin::BUZZER, frequence);
    else noTone(pin::BUZZER);
  }
}

// =====================================================================
// Auto-test au démarrage : chaque actionneur s'active brièvement
// =====================================================================
void autoTest() {
  struct Etape {
    uint8_t broche;
    const char* nom;
  };
  const Etape etapes[] = {{pin::LED_VERTE, "LED verte"},       {pin::LED_ORANGE, "LED orange"},
                          {pin::LED_ROUGE, "LED rouge"},       {pin::VIBRATION, "Vibration"},
                          {pin::LED_CONNEXION, "LED connexion"}, {pin::RELAIS, "Relais"}};
  Serial.println("Auto-test...");
  for (const auto& e : etapes) {
    afficher("Auto-test...", e.nom);
    digitalWrite(e.broche, HIGH);
    delay(300);
    digitalWrite(e.broche, LOW);
  }
  afficher("Auto-test...", "Buzzer");
  tone(pin::BUZZER, 1500);
  delay(150);
  tone(pin::BUZZER, 2500);
  delay(150);
  noTone(pin::BUZZER);

  afficher("Auto-test OK", sdOk ? "Carte SD : OK" : "Carte SD absente");
  delay(1000);
  journaliser("AUTOTEST", 0, sdOk ? "OK, carte SD OK" : "OK, carte SD absente");
}

void setup() {
  Serial.begin(115200);
  for (uint8_t p : {pin::LED_VERTE, pin::LED_ORANGE, pin::LED_ROUGE, pin::LED_CONNEXION, pin::VIBRATION, pin::RELAIS})
    pinMode(p, OUTPUT);
  pinMode(pin::BOUTON, INPUT_PULLUP);

  lcd.init();
  lcd.backlight();

  Serial.println();
  Serial.println("=== DriveAlert AI - boitier d'alerte ===");

  spiSD.begin(pin::SD_SCK, pin::SD_MISO, pin::SD_MOSI, pin::SD_CS);
  sdOk = SD.begin(pin::SD_CS, spiSD);
  if (sdOk && !SD.exists(FICHIER_JOURNAL)) creerEnTeteJournal();
  Serial.println(sdOk ? "Carte SD : OK (journal dans /journal.csv)" : "Carte SD absente : journal en memoire");

  journaliser("DEMARRAGE", 0, "boitier allume");
  mqtt.setServer(MQTT_HOTE, MQTT_PORT);
  mqtt.setCallback(recevoirMqtt);
  mqtt.setBufferSize(1024);
  demarrerWifi();  // se connecte en arrière-plan pendant l'auto-test
  autoTest();
  Serial.println(!sosSimule() ? "SOS WhatsApp : Green-API configure"
                                          : "SOS WhatsApp : mode simulation (remplir include/secrets.h)");

  debutNiveau = debutConduite = millis();
  aide();
}

void loop() {
  lireSerie();
  lireBouton();
  majPause();
  majConnexion();
  majWifi();
  majMqtt();
  majSos();
  majSorties();
  majEcran();
  delay(5);
}
