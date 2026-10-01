# Unisson — bêta

Lecture audio synchronisée sur plusieurs appareils (ordinateur, téléphones), chacun sur sa propre
sortie son — haut-parleur intégré ou enceinte Bluetooth — avec calibration de la latence au micro.

C'est un prototype web : un petit serveur sur l'ordinateur, une page ouverte sur chaque appareil.

## Lancer

```sh
node server.mjs
```

- Sur l'ordinateur : <http://localhost:8080>
- Sur le téléphone (même Wi-Fi) : l'adresse `https://…:8443` affichée au démarrage. Le certificat est
  auto-signé : accepter l'avertissement (le navigateur n'autorise le micro qu'en HTTPS).

Aucune dépendance pour le serveur (Node 18+, `openssl` pour générer le certificat).

## Protocole de test

1. Cliquer **Rejoindre** sur chaque appareil.
2. Choisir **Métronome** puis **Lecture** : sans calibration, on entend le décalage (écho entre les clics).
3. Sur l'ordinateur, **Calibrer** : chaque appareil émet trois signaux brefs, le micro de l'ordinateur
   mesure la latence de chacun et la compensation est appliquée automatiquement.
4. **Vérifier** rejoue les signaux avec compensation : l'« écart entre appareils » doit être proche de 0.
5. Relancer la lecture et juger à l'oreille ; les boutons ± ms ajustent chaque appareil, y compris à distance.
6. **Test de stabilité** : dix mesures à la suite, sans toucher à la compensation. Le résumé donne la
   variation de l'écart entre appareils ; c'est elle qui dit si une calibration unique suffit.

7. **Suivi continu** (après une calibration) : chaque appareil joue en permanence une signature très
   discrète, l'appareil qui écoute mesure les écarts toutes les 6 à 10 s et les corrige, y compris
   pendant la musique. Le curseur règle le niveau de la signature : le plus bas qui reste détecté.

Chaque mesure est gardée dans l'historique de la page et écrite dans la sortie du serveur.

Mieux vaut que ce soit l'ordinateur qui écoute : sur téléphone, ouvrir le micro peut changer le trajet
du son (mode « appel », profil Bluetooth mains-libres) et fausser la mesure.

## Comment ça marche

- **Horloge commune** : chaque page estime son décalage avec l'horloge du serveur (allers-retours HTTP,
  on garde le plus court).
- **Lecture** : le serveur diffuse « position P à l'heure T » ; chaque page programme le son dans son
  horloge audio, en avance de sa latence, puis corrige la dérive en continu (vitesse ±1 % au plus).
- **Calibration** : un balayage 1–6 kHz de 150 ms par créneau ; l'appareil qui écoute le retrouve par
  corrélation croisée (`public/dsp.js`). Un seul micro mesure tout le monde, donc sa propre latence
  s'annule dans les écarts.
- **Suivi continu** : la signature de chaque appareil est un bruit à bande limitée (2–6 kHz) qui lui est
  propre, calé sur l'horloge commune comme la musique. Le micro la retrouve par corrélation sur des
  blocs de 171 ms dont on additionne les énergies pendant 5,5 s, en essayant plusieurs glissements
  d'horloge. Seuls les écarts entre appareils servent : chacun est ramené vers la moyenne du groupe.
- **Sortie maintenue éveillée** : chaque page joue en permanence un bruit infime (−80 dB), pour que la
  sortie audio ne se mette pas en veille pendant les silences et ne change pas de latence au réveil.

## Limites connues

- La synchro n'est exacte qu'à l'emplacement du micro (le son parcourt ~3 ms par mètre).
- Le suivi continu ne rattrape que ±85 ms autour de la calibration et corrige par pas de 15 ms au plus ;
  au-delà, recalibrer. Il n'a été validé qu'en simulation et en boucle interne.
- Le trajet du micro ajoute à toutes les mesures un décalage commun qui dérive : seules les valeurs
  relatives entre appareils sont fiables, les latences absolues ne le sont pas.
- Sources : métronome ou fichier audio local envoyé depuis la page (gardé en mémoire, 80 Mo max).
  Pour un MP3, utiliser le même navigateur partout (le décodage n'ajoute pas le même silence initial
  selon les navigateurs).
- Écran du téléphone allumé et page au premier plan, sinon le navigateur suspend le son.

## Tests

```sh
npm test         # traitement du signal (chirp, signature) et modèle d'horloge
npm install      # une fois, pour le test suivant
npm run smoke    # bout en bout dans Chrome sans écran : deux pages, lecture, calibration et suivi en boucle interne
```
