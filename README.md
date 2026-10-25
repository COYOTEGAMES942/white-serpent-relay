# The White Serpent - lobby relay

The online lobby server for The White Serpent's multiplayer (Windows, Android, iPhone).

It keeps the list of open lobbies and passes messages between the players in each one. The battle itself runs on the host player's device. It has no dependencies and listens on `$PORT` (default 47630).

    node relay.js

In the game, every player enters this server's address in **Multiplayer > Online server**, for example `wss://white-serpent-relay.onrender.com`.
