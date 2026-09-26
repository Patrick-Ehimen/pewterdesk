import type { Messages } from "./en";

// French.
export const messages: Messages = {
  "col.price": "Prix",
  "col.size": "Taille",
  "col.total": "Total",
  "col.time": "Heure",
  "col.market": "Marché",
  "col.side": "Sens",
  "col.type": "Type",
  "col.filled": "Exécuté",
  "col.trigger": "Déclenchement",
  "col.reduceOnly": "Réduction seule",
  "col.status": "Statut",
  "col.entry": "Entrée",
  "col.mark": "Prix de référence",
  "col.liq": "Liq.",
  "col.upnl": "PnL latent (ROE)",
  "col.margin": "Marge",
  "col.maxLeverage": "Levier max.",
  "col.tickSize": "Pas de cotation",
  "col.sizeStep": "Pas de taille",
  "col.minSize": "Taille min.",

  "side.buy": "Achat",
  "side.sell": "Vente",
  "side.long": "Long",
  "side.short": "Short",
  "side.bid": "Offre d'achat",
  "side.ask": "Offre de vente",
  "common.yes": "Oui",
  "common.no": "Non",
  "orderType.market": "Marché",
  "orderType.limit": "Limite",
  "orderType.trigger": "Conditionnel",
  "orderStatus.pending": "En attente",
  "orderStatus.open": "Ouvert",
  "orderStatus.filled": "Exécuté",
  "orderStatus.cancelled": "Annulé",
  "orderStatus.rejected": "Rejeté",

  "hint.unit": "En {asset}.",
  "hint.book.price":
    "Prix limite des ordres placés à ce niveau. Les offres de vente (vendeurs) sont au-dessus du spread, les offres d'achat (acheteurs) en dessous.",
  "hint.book.size": "Tout ce qui est placé exactement à ce prix.",
  "hint.book.total":
    "Taille cumulée depuis le spread jusqu'à ce niveau : ce qu'un ordre au marché devrait absorber pour arriver ici. La barre ombrée montre la même chose.",
  "hint.trades.price":
    "Prix auquel la transaction s'est exécutée. Vert quand un acheteur a pris une offre de vente, rouge quand un vendeur a frappé une offre d'achat.",
  "hint.trades.size": "Quantité échangée.",
  "hint.trades.time": "Heure de la transaction, dans votre fuseau horaire.",

  "tip.sizeHere": "Taille ici",
  "tip.valueHere": "Valeur ici",
  "tip.totalToHere": "Total jusqu'ici",
  "tip.valueToHere": "Valeur jusqu'ici",
  "tip.avgFill": "Prix moyen d'exécution",
  "tip.fromMid": "Écart au prix médian",
  "tip.value": "Valeur",
  "tip.tradeBuy": "Achat — le preneur a pris une offre de vente",
  "tip.tradeSell": "Vente — le preneur a frappé une offre d'achat",

  "book.spread": "spread {spread} · {bps} pb",
  "book.ratio": "Achats {bids}, ventes {asks}",
  "book.ratioBid": "A",
  "book.ratioAsk": "V",
  "book.loading": "Chargement du carnet d'ordres",
  "trades.loading": "Chargement des transactions",
  "trades.empty": "Aucune transaction pour l'instant.",

  "account.equity": "Capitaux",
  "account.upnl": "PnL latent",
  "account.marginUsed": "Marge utilisée",
  "account.available": "Disponible",
  "account.marginRatio": "Ratio de marge",
  "positions.empty": "Aucune position ouverte.",
  "orders.empty": "Aucun ordre ouvert.",

  "markets.search": "Rechercher des marchés",
  "markets.show": "Afficher",
  "markets.all": "Tous",
  "markets.watchlist": "Favoris ({count})",
  "markets.watchlistColumn": "Favoris",
  "markets.watchlistEmpty":
    "Vos favoris sont vides. Cliquez sur l'étoile d'un marché pour l'ajouter.",
  "markets.noMatch": "Aucun marché ne correspond à « {query} ».",
  "star.add": "Ajouter {name} aux favoris",
  "star.remove": "Retirer {name} des favoris",

  "panel.markets": "Marchés",
  "panel.orderBook": "Carnet d'ordres",
  "panel.account": "Compte",
  "panel.positions": "Positions",
  "panel.remove": "Retirer « {panel} »",
  "tab.orderBook": "Carnet d'ordres",
  "tab.trades": "Transactions",
  "tab.positions": "Positions",
  "tab.openOrders": "Ordres ouverts",
  "menu.view": "Affichage",
  "menu.bookOptions": "Options du carnet d'ordres",
  "menu.tradesOptions": "Options des transactions",
  "view.table": "Tableau",
  "view.tableDesc": "Une ligne par entrée, en colonnes",
  "view.stacked": "Empilé",
  "view.stackedDesc": "Deux lignes par entrée, plus lisible",

  "feed.loading": "Chargement…",
  "feed.closed": "Flux fermé — dernière mise à jour affichée.",
  "feed.pickMarket": "Choisissez un marché.",
  "feed.noAccount": "Aucun compte à afficher.",
  "feed.connectToWatch":
    "Connectez un wallet (en haut à droite) pour suivre un compte. Lecture seule — aucune clé requise.",

  "header.mid": "Médian",

  "header.home": "Aller au trading",

  // Market stats bar

  "stats.chooseMarket": "Choisir un marché",

  "stats.marketInfo": "{venue} · jusqu'à {leverage}x · pas {tick} · taille min. {min}",

  "stats.markHint": "Prix de référence : celui qu'utilisent la marge, le PnL et les liquidations.",

  "stats.mid": "Prix médian",

  "stats.midHint": "Milieu entre la meilleure offre d'achat et de vente.",

  "stats.index": "Prix de l'indice",

  "stats.indexHint": "Le prix de l'oracle que suit le prix de référence.",

  "stats.change": "Variation 24 h",

  "stats.high": "Plus haut 24 h",

  "stats.low": "Plus bas 24 h",

  "stats.volume": "Volume 24 h ({asset})",

  "stats.openInterest": "Intérêt ouvert ({asset})",

  "stats.funding": "Funding / compte à rebours",

  "stats.fundingHint":
    "Payé toutes les {hours} h entre longs et shorts. Positif : les longs paient les shorts ; négatif : les shorts paient les longs.",

  "stats.loading": "Chargement des statistiques du marché",
  "header.upTo": "jusqu'à {leverage}x",
  "action.editLayout": "Modifier la disposition",
  "action.doneLayout": "Terminer la disposition",
  "action.mute": "Couper les sons",
  "action.unmute": "Réactiver les sons",
  "action.settings": "Réglages",
  "action.language": "Langue : {language}",
  "menu.language": "Langue",
  "menu.theme": "Thème",
  "action.theme": "Thème : {theme}",
  "theme.dark.name": "Étain",
  "theme.dark.desc": "Étain et laiton sur un quasi-noir",
  "theme.graphite.name": "Graphite",
  "theme.graphite.desc": "Plus froid, un cran plus clair",
  "theme.synthwave.name": "Synthwave '84",
  "theme.synthwave.desc": "Rose néon sur violet rétro",
  "theme.monokai.name": "Monokai Pro",
  "theme.monokai.desc": "Filtre Machine : jaune sur gris froid",
  "theme.palenight.name": "Palenight",
  "theme.palenight.desc": "Violet doux sur bleu ardoise",
  "theme.parchment.name": "Parchemin",
  "theme.parchment.desc": "Clair et chaleureux, ton papier",

  // Settings page
  "settings.title": "Réglages",
  "settings.back": "Retour au trading",
  "settings.soon": "Bientôt",
  "settings.comingSoon": "Pas encore disponible",
  "settings.nav.general": "Général",
  "settings.nav.wallets": "Wallets et clés",
  "settings.nav.trading": "Trading",
  "settings.nav.hotkeys": "Raccourcis",
  "settings.nav.notifications": "Notifications",
  "settings.nav.appearance": "Apparence",
  "settings.nav.network": "Réseau",
  "settings.nav.advanced": "Avancé",
  "settings.general.desc": "Langue et son.",
  "settings.languageHelp": "Changer de langue recharge l'application.",
  "settings.sounds": "Sons",
  "settings.soundsHelp":
    "Sons d'alerte pour les exécutions et le risque de liquidation, dès l'arrivée du trading.",
  "settings.wallets.desc":
    "Suivez n'importe quel compte en lecture seule. Les clés de trading arrivent avec le passage d'ordres.",
  "settings.watched": "Compte suivi",
  "settings.watchedHelp": "Lecture seule : soldes, positions et ordres ouverts, sans signature.",
  "settings.noWatched": "Aucun compte suivi pour l'instant.",
  "settings.copyAddress": "Copier l'adresse",
  "settings.copied": "Copiée",
  "settings.keys": "Clés de trading",
  "settings.keysNone": "Aucune clé sur cet appareil.",
  "settings.keysHelp":
    "Les clés dédiées au trading arrivent avec le passage d'ordres. Elles sont conservées uniquement dans le trousseau du système et ne peuvent pas retirer de fonds.",
  "settings.safeguards": "Protections de signature",
  "settings.safeguardsHelp":
    "Touch ID avant de signer, verrouillage en cas d'inactivité et confirmation des gros ordres arrivent avec le passage d'ordres.",
  "settings.trading.desc":
    "Taille d'ordre, slippage et levier par défaut. Arrive avec le passage d'ordres.",
  "settings.hotkeys.desc":
    "Raccourcis clavier pour passer et annuler des ordres. Arrive avec le passage d'ordres.",
  "settings.notifications.desc": "Alertes d'exécution et de risque de liquidation.",
  "settings.network.desc": "Points d'accès des plateformes et état de la connexion.",
  "settings.appearance.desc":
    "Thème, couleurs du marché et disposition du carnet d'ordres et des transactions.",
  "settings.bookView": "Affichage du carnet d'ordres",
  "settings.tradesView": "Affichage des transactions",
  "settings.advanced.desc":
    "Réinitialisez ce que cet appareil mémorise. Rien ici ne touche aux clés ni aux plateformes.",
  "settings.resetLayout": "Réinitialiser la disposition",
  "settings.resetLayoutHelp": "Remettre les panneaux dans leur disposition par défaut.",
  "settings.clearWatchlist": "Vider les favoris",
  "settings.clearWatchlistHelp": "Retirer l'étoile de tous les marchés.",
  "settings.resetAll": "Réinitialiser toutes les préférences",
  "settings.resetAllHelp":
    "Thème, langue, dispositions, favoris et compte suivi reviennent aux valeurs par défaut, et l'application se recharge.",
  "settings.resetAllButton": "Tout réinitialiser",
  "settings.confirm": "Cliquez à nouveau pour confirmer",
  "settings.doneFeedback": "Fait",
  "settings.marketColors": "Couleurs du marché",
  "colors.standard": "Vert / rouge",
  "colors.standardDesc": "Couleurs de marché standard",
  "colors.colorblind": "Bleu / orange",
  "colors.colorblindDesc": "Plus faciles à distinguer en cas de daltonisme",

  "layout.editor": "Éditeur de disposition",
  "layout.editing": "Modification de la disposition",
  "layout.hint": "Faites glisser les titres pour déplacer · les bords pour redimensionner",
  "layout.saveAs": "Enregistrer sous…",
  "layout.done": "Terminé",
  "layout.name": "Nom de la disposition",
  "layout.nameTaken": "Ce nom appartient à une disposition intégrée",
  "layout.delete": "Supprimer la disposition {name}",
  "preset.Default": "Par défaut",
  "preset.Scalping": "Scalping",
  "preset.Swing": "Swing",
  "palette.title": "Panneaux",
  "palette.help":
    "Faites glisser sur la grille ou cliquez pour ajouter en bas. Un panneau peut apparaître plusieurs fois.",
  "palette.inLayout": "dans la disposition",

  "wallet.connect": "Connecter un wallet",
  "wallet.close": "Fermer",
  "wallet.watchingAddress": "Suivi de {address}",
  "wallet.wc": "WalletConnect",
  "wallet.wcDetail": "Scannez un QR code avec le wallet de votre téléphone",
  "wallet.ledger": "Ledger",
  "wallet.ledgerDetail": "Wallet matériel en USB",
  "wallet.api": "Importer un wallet API",
  "wallet.apiDetail": "Utilisez une clé d'agent déjà approuvée",
  "wallet.watch": "Suivre une adresse",
  "wallet.watchDetail": "Lecture seule, sans signature",
  "wallet.soon": "Pas encore disponible",
  "wallet.note":
    "Pour trader, il faut une clé de trading dédiée par plateforme, qui arrivera avec le passage d'ordres. En attendant, suivez n'importe quelle adresse pour voir ses positions et ses ordres.",
  "wallet.watchTitle": "Suivre une adresse",
  "wallet.watchHelp":
    "Consultez les soldes, positions et ordres ouverts de n'importe quel compte sans rien signer. Rien ici ne permet de trader.",
  "wallet.stopWatching": "Arrêter le suivi",
  "wallet.watchAnother": "Suivre une autre adresse",
  "wallet.address": "Adresse",
  "wallet.invalid": "Ce n'est pas une adresse — attendu : 0x suivi de 40 caractères hexadécimaux.",
  "wallet.footer":
    "Pewterdesk ne voit jamais votre phrase de récupération. Les connexions vont directement de cet appareil à chaque plateforme.",

  "error.noTauri":
    "Les données de marché nécessitent l'application de bureau — lancez `make dev`, pas `make dev-ui`.",
  "error.failed": "L'appel à la plateforme a échoué.",
  "error.unsupported": "Non pris en charge : {detail}",
  "error.invalidRequest": "Requête invalide : {detail}",
  "error.rejected": "Rejeté par la plateforme : {detail}",
  "error.network": "Erreur réseau : {detail}",
  "error.noKey": "Aucune clé enregistrée pour ce compte.",
  "error.key": "Erreur de clé : {detail}",
  "error.feedClosed": "La plateforme a fermé le flux.",
};
