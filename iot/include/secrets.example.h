// Modèle des réglages secrets du boîtier.
// Copier ce fichier en « secrets.h » (même dossier) et le remplir.
// secrets.h est ignoré par git : votre numéro et votre clé ne partent jamais sur GitHub.
#pragma once

// Wi-Fi : « Wokwi-GUEST » (sans mot de passe) est le réseau virtuel du simulateur Wokwi.
#define WIFI_SSID "Wokwi-GUEST"
#define WIFI_MOTDEPASSE ""

// Green-API (WhatsApp gratuit, offre « Developer ») :
// 1. créez un compte sur green-api.com et une instance « Developer » (gratuite) ;
// 2. reliez votre WhatsApp en scannant le QR code (comme WhatsApp Web) ;
// 3. recopiez ici l'apiUrl, l'idInstance et l'apiTokenInstance affichés dans la console.
// Laissés vides : le SOS est seulement affiché dans le moniteur série (mode simulation).
#define GREENAPI_URL ""          // ex. "https://7103.api.greenapi.com"
#define GREENAPI_ID_INSTANCE ""  // ex. "7103123456"
#define GREENAPI_TOKEN ""        // ex. "d75b3a66374942c5b3c019c698abc2067e151558acbd412345"

// Numéro qui reçoit les alertes (format international, sans « + »).
#define WHATSAPP_NUMERO "2126XXXXXXXX"

// Position envoyée dans le SOS (Wokwi n'a pas de GPS : position simulée).
#define POSITION_LAT "33.5731"
#define POSITION_LON "-7.5898"
