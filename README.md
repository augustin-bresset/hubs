# Unisson — bêta

Lecture audio synchronisée sur plusieurs appareils (ordinateur, téléphones), chacun sur sa propre
sortie son — haut-parleur intégré ou enceinte Bluetooth — avec calibration de la latence au micro.

C'est un prototype web : un petit serveur sur l'ordinateur, une page ouverte sur chaque appareil.

## Lancer

```sh
node server.mjs
```

- Sur l'ordinateur : <http://localhost:8080>. Se connecter, créer une salle, l'ouvrir.
- Sur les autres appareils (même Wi-Fi) : le lien `https://…:8443/r/CODE` affiché dans la salle. Le
  certificat est auto-signé : accepter l'avertissement (le navigateur n'autorise le micro qu'en HTTPS).

Aucune dépendance pour le serveur (Node 18+, `openssl` pour générer le certificat).

## Comptes et salles

- **Salle** : une adresse `/r/CODE` avec ses propres appareils, sa lecture et son suivi. On la rejoint
  sans compte, avec le lien ou le code.
- **Compte** : nécessaire pour créer une salle (10 au plus) et y envoyer un morceau. Connexion par
  Google (OpenID Connect, flux « code » avec PKCE) ; la session tient dans un cookie signé.
- Sans identifiants Google, une **connexion de développement** sans mot de passe est proposée, depuis
  la machine qui héberge le serveur seulement.

Configuration, par variables d'environnement :

| Variable | Rôle |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Identifiants OAuth « application Web » créés dans la console Google Cloud, avec `PUBLIC_URL/auth/callback` comme URI de redirection autorisée. |
| `PUBLIC_URL` | Adresse publique du service (défaut : `http://localhost:8080`). |
| `SESSION_SECRET` | Clé de signature des sessions (sinon générée dans `data/`). |
| `TRUST_PROXY=1` | Derrière un mandataire qui termine le HTTPS : cookies marqués `Secure`. |
| `DATA_DIR` | Comptes, salles et clé de session (défaut : `data/`, hors git). |
| `DEV_LOGIN=1` / `0` | Force ou interdit la connexion de développement. |

Limites actuelles pour un vrai service : comptes et salles dans des fichiers JSON, morceaux gardés en
mémoire (80 Mo par salle), pas de limitation de débit, un seul processus.

## Protocole de test

1. Ouvrir la salle sur chaque appareil et cliquer **Rejoindre**.
2. Choisir **Métronome** puis **Lecture** : sans calibration, on entend le décalage (écho entre les clics).
3. Sur l'ordinateur, **Calibrer** : chaque appareil émet trois signaux brefs, le micro de l'ordinateur
   mesure la latence de chacun et la compensation est appliquée automatiquement.
4. **Vérifier** rejoue les signaux avec compensation : l'« écart entre appareils » doit être proche de 0.
5. Relancer la lecture et juger à l'oreille ; les boutons ± ms ajustent chaque appareil, y compris à distance.
6. **Test de stabilité** : dix mesures à la suite, sans toucher à la compensation. Le résumé donne la
   variation de l'écart entre appareils ; c'est elle qui dit si une calibration unique suffit.

7. **Suivi continu** (après une calibration, pendant que la musique joue) : l'appareil qui écoute
   mesure l'écart entre appareils toutes les 6 à 10 s dans la musique elle-même et le corrige.

Chaque mesure est gardée dans l'historique de la page et écrite dans la sortie du serveur.

Mieux vaut que ce soit l'ordinateur qui écoute : sur téléphone, ouvrir le micro peut changer le trajet
du son (mode « appel », profil Bluetooth mains-libres) et fausser la mesure.

## Direct : l'ordinateur diffuse vers les appareils

Dans une salle, le créateur dispose d'un bloc « En direct depuis cet ordinateur » : il choisit une
source, un retard, et tout ce qui y joue ressort, synchronisé, sur les appareils de la salle (chacun
sur son enceinte). Sources possibles :

- **Son d'un onglet** (Chrome ou Edge sur ordinateur) : partager l'onglet où joue la musique en
  cochant le partage du son. L'onglet est rendu muet sur place, il ressort par le direct.
- **Entrée audio** : carte son, table de mixage, micro. Attention au micro intégré : il capte la
  pièce, donc aussi les enceintes.
- **Câble virtuel**, pour une application ou un logiciel de mix. Sous Linux :
  `tools/linux-virtual-input.sh on`, puis diriger l'application vers la sortie « Cable-direct » et
  choisir l'entrée « Source-direct » comme source du direct (`off` pour le retirer). Sous Windows et
  macOS, des outils comme VB-Cable ou BlackHole jouent le même rôle.

Le retard (1 s par défaut) sépare la capture de l'écoute : il doit dépasser la plus grande
compensation des appareils d'environ 0,3 s. Il rend le direct inadapté à qui doit entendre son
propre geste sans délai : pour mixer, on écoute au casque et la salle suit avec ce retard.

Le son voyage en clair et sans compression (environ 1,5 Mbit/s par appareil), via le serveur.

## Comment ça marche

- **Horloge commune** : chaque page estime son décalage avec l'horloge du serveur (allers-retours HTTP,
  on garde le plus court).
- **Lecture** : le serveur diffuse « position P à l'heure T » ; chaque page programme le son dans son
  horloge audio, en avance de sa latence, puis corrige la dérive en continu (vitesse ±1 % au plus).
- **Calibration** : un balayage 1–6 kHz de 150 ms par créneau ; l'appareil qui écoute le retrouve par
  corrélation croisée (`public/dsp.js`). Un seul micro mesure tout le monde, donc sa propre latence
  s'annule dans les écarts.
- **Suivi continu** : la musique sert de signal de mesure. Chaque appareil a une bande de 600 Hz
  (entre 3,4 et 6,9 kHz) où il est le seul à la jouer : pendant le suivi, les autres la retirent de
  leur musique. Le micro corrèle ce qu'il entend avec la musique dans la bande de chaque appareil,
  par blocs de 171 ms dont on additionne les énergies pendant 5,5 s. Rien n'est ajouté au son, et
  un appareil bien moins fort que les autres reste mesurable puisqu'il est seul dans sa bande.
  Une enceinte lointaine arrive surtout par la pièce, en une bosse étalée sur des dizaines de ms :
  on mesure donc le début de l'arrivée (front montant du profil lissé), pas un pic. L'appareil le
  mieux reconnu sert de référence ; l'écart des autres vient du cumul de leurs six dernières
  fenêtres, recalées sur lui. Les corrections sont prudentes : rien sous 2 ms d'écart, 6 ms au plus
  par pas. Quatre appareils au plus.
- **Direct** : l'hôte découpe le son capté en tranches de 100 ms, chacune datée de l'heure commune
  de sa capture. Une droite ajustée sur ces dates donne le rythme réel de sa carte son ; chaque
  appareil lit le flux avec un lecteur à vitesse variable asservi à cette horloge, pour faire
  entendre chaque échantillon un retard fixe après sa capture. Le suivi continu s'applique tel quel,
  la référence étant le flux reçu.
- **Sortie maintenue éveillée** : chaque page joue en permanence un bruit infime (−80 dB), pour que la
  sortie audio ne se mette pas en veille pendant les silences et ne change pas de latence au réveil.

## Limites connues

- La synchro n'est exacte qu'à l'emplacement du micro (le son parcourt ~3 ms par mètre).
- Le suivi continu ne mesure que quand la musique joue et contient de l'énergie entre 3 et 7 kHz. Il
  corrige par pas de 15 ms au plus. Validé en simulation et en boucle interne (Chrome et Firefox),
  pas encore avec de vraies enceintes.
- Pendant le suivi, chaque appareil joue la musique avec une bande étroite en moins.
- Sous Firefox, la position de lecture flotte d'environ ±1 ms.
- Le trajet du micro ajoute à toutes les mesures un décalage commun qui dérive : seules les valeurs
  relatives entre appareils sont fiables, les latences absolues ne le sont pas.
- Sources : métronome ou fichier audio local envoyé depuis la page (gardé en mémoire, 80 Mo max).
  Pour un MP3, utiliser le même navigateur partout (le décodage n'ajoute pas le même silence initial
  selon les navigateurs).
- Écran du téléphone allumé et page au premier plan, sinon le navigateur suspend le son.
- Direct : validé en boucle interne avec un son de test ; la capture d'une vraie source (onglet, carte
  son) n'a pas encore été essayée. Pas d'enregistrement de diagnostic pendant un direct.

## Tests

```sh
npm test               # traitement du signal, modèle d'horloge, comptes et salles (faux fournisseur d'identité)
npm install            # une fois, pour les tests suivants
npm run smoke          # bout en bout dans Chrome sans écran : lecture, calibration, suivi en boucle interne
npm run smoke:firefox  # le même scénario sous Firefox
```

## Diagnostic

Pendant le suivi, l'appareil qui écoute envoie au serveur ce que son micro entend (s'il tourne sur la
même machine). Les douze dernières fenêtres et le morceau joué sont gardés dans `captures/CODE/` ;
`node tools/analyze-capture.mjs` rejoue la mesure dessus (nécessite `ffmpeg`).
