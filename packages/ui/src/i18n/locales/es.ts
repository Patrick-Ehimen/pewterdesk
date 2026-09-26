import type { Messages } from "./en";

// Spanish.
export const messages: Messages = {
  "col.price": "Precio",
  "col.size": "Tamaño",
  "col.total": "Total",
  "col.time": "Hora",
  "col.market": "Mercado",
  "col.side": "Lado",
  "col.type": "Tipo",
  "col.filled": "Ejecutado",
  "col.trigger": "Disparo",
  "col.reduceOnly": "Solo reducir",
  "col.status": "Estado",
  "col.entry": "Entrada",
  "col.mark": "Marca",
  "col.liq": "Liq.",
  "col.upnl": "PnL no realizado (ROE)",
  "col.margin": "Margen",
  "col.maxLeverage": "Apalancamiento máx.",
  "col.tickSize": "Tick",
  "col.sizeStep": "Paso de tamaño",
  "col.minSize": "Tamaño mín.",

  "side.buy": "Compra",
  "side.sell": "Venta",
  "side.long": "Largo",
  "side.short": "Corto",
  "side.bid": "Oferta de compra",
  "side.ask": "Oferta de venta",
  "common.yes": "Sí",
  "common.no": "No",
  "orderType.market": "Mercado",
  "orderType.limit": "Límite",
  "orderType.trigger": "Condicional",
  "orderStatus.pending": "Pendiente",
  "orderStatus.open": "Abierta",
  "orderStatus.filled": "Ejecutada",
  "orderStatus.cancelled": "Cancelada",
  "orderStatus.rejected": "Rechazada",

  "hint.unit": "En {asset}.",
  "hint.book.price":
    "Precio límite de las órdenes en este nivel. Las ofertas de venta (vendedores) están por encima del spread y las de compra (compradores), por debajo.",
  "hint.book.size": "Todo lo que hay exactamente a este precio.",
  "hint.book.total":
    "Tamaño acumulado desde el spread hasta este nivel: lo que una orden de mercado tendría que consumir para llegar aquí. La barra sombreada muestra lo mismo.",
  "hint.trades.price":
    "Precio al que se ejecutó la operación. Verde cuando un comprador tomó una oferta de venta, rojo cuando un vendedor golpeó una de compra.",
  "hint.trades.size": "Cuánto cambió de manos.",
  "hint.trades.time": "Cuándo se ejecutó la operación, en tu hora local.",

  "tip.sizeHere": "Tamaño aquí",
  "tip.valueHere": "Valor aquí",
  "tip.totalToHere": "Total hasta aquí",
  "tip.valueToHere": "Valor hasta aquí",
  "tip.avgFill": "Precio medio de ejecución",
  "tip.fromMid": "Desde el precio medio",
  "tip.value": "Valor",
  "tip.tradeBuy": "Compra: el tomador compró una oferta de venta",
  "tip.tradeSell": "Venta: el tomador vendió a una oferta de compra",

  "book.spread": "spread {spread} · {bps} pb",
  "book.ratio": "Compras {bids}, ventas {asks}",
  "book.ratioBid": "C",
  "book.ratioAsk": "V",
  "book.loading": "Cargando el libro de órdenes",
  "trades.loading": "Cargando operaciones",
  "trades.empty": "Aún no hay operaciones.",

  "account.equity": "Patrimonio",
  "account.upnl": "PnL no realizado",
  "account.marginUsed": "Margen usado",
  "account.available": "Disponible",
  "account.marginRatio": "Ratio de margen",
  "positions.empty": "No hay posiciones abiertas.",
  "orders.empty": "No hay órdenes abiertas.",

  "markets.search": "Buscar mercados",
  "markets.show": "Mostrar",
  "markets.all": "Todos",
  "markets.watchlist": "Favoritos ({count})",
  "markets.watchlistColumn": "Favoritos",
  "markets.watchlistEmpty":
    "Tu lista de favoritos está vacía. Marca un mercado con la estrella para añadirlo.",
  "markets.noMatch": "Ningún mercado coincide con «{query}».",
  "star.add": "Añadir {name} a favoritos",
  "star.remove": "Quitar {name} de favoritos",

  "panel.markets": "Mercados",
  "panel.orderBook": "Libro de órdenes",
  "panel.account": "Cuenta",
  "panel.positions": "Posiciones",
  "panel.remove": "Quitar {panel}",
  "tab.orderBook": "Libro de órdenes",
  "tab.trades": "Operaciones",
  "tab.positions": "Posiciones",
  "tab.openOrders": "Órdenes abiertas",
  "menu.view": "Vista",
  "menu.bookOptions": "Opciones del libro de órdenes",
  "menu.tradesOptions": "Opciones de operaciones",
  "view.table": "Tabla",
  "view.tableDesc": "Una línea por fila, en columnas",
  "view.stacked": "Apilada",
  "view.stackedDesc": "Dos líneas por fila, más fácil de leer",

  "feed.loading": "Cargando…",
  "feed.closed": "Flujo cerrado: se muestra la última actualización.",
  "feed.pickMarket": "Elige un mercado.",
  "feed.noAccount": "No hay ninguna cuenta que mostrar.",
  "feed.connectToWatch":
    "Conecta una wallet (arriba a la derecha) para seguir una cuenta. Solo lectura: no se necesita clave.",

  "header.mid": "Medio",

  "header.home": "Ir al trading",

  // Market stats bar

  "stats.chooseMarket": "Elige un mercado",

  "stats.marketInfo": "{venue} · hasta {leverage}x · tick {tick} · tamaño mín. {min}",

  "stats.markHint": "Precio de marca: el que usan el margen, el PnL y las liquidaciones.",

  "stats.mid": "Precio medio",

  "stats.midHint": "Punto medio entre la mejor compra y la mejor venta.",

  "stats.index": "Precio índice",

  "stats.indexHint": "El precio del oráculo que sigue la marca.",

  "stats.change": "Cambio 24h",

  "stats.high": "Máximo 24h",

  "stats.low": "Mínimo 24h",

  "stats.volume": "Volumen 24h ({asset})",

  "stats.openInterest": "Interés abierto ({asset})",

  "stats.funding": "Funding / cuenta atrás",

  "stats.fundingHint":
    "Se paga cada {hours} h entre largos y cortos. Positivo: los largos pagan a los cortos; negativo: los cortos pagan a los largos.",

  "stats.loading": "Cargando estadísticas del mercado",
  "header.upTo": "hasta {leverage}x",
  "action.editLayout": "Editar diseño",
  "action.doneLayout": "Terminar de editar el diseño",
  "action.mute": "Silenciar sonidos",
  "action.unmute": "Activar sonidos",
  "action.settings": "Ajustes",
  "action.language": "Idioma: {language}",
  "menu.language": "Idioma",
  "menu.theme": "Tema",
  "action.theme": "Tema: {theme}",
  "theme.dark.name": "Peltre",
  "theme.dark.desc": "Peltre y latón sobre casi negro",
  "theme.graphite.name": "Grafito",
  "theme.graphite.desc": "Más frío y un poco más claro",
  "theme.synthwave.name": "Synthwave '84",
  "theme.synthwave.desc": "Rosa neón sobre púrpura retro",
  "theme.monokai.name": "Monokai Pro",
  "theme.monokai.desc": "Filtro Machine: amarillo sobre gris frío",
  "theme.palenight.name": "Palenight",
  "theme.palenight.desc": "Morado suave sobre azul pizarra",
  "theme.parchment.name": "Pergamino",
  "theme.parchment.desc": "Claro y cálido, tono papel",

  // Settings page
  "settings.title": "Ajustes",
  "settings.back": "Volver al trading",
  "settings.soon": "Pronto",
  "settings.comingSoon": "Aún no disponible",
  "settings.nav.general": "General",
  "settings.nav.wallets": "Wallets y claves",
  "settings.nav.trading": "Trading",
  "settings.nav.hotkeys": "Atajos",
  "settings.nav.notifications": "Notificaciones",
  "settings.nav.appearance": "Apariencia",
  "settings.nav.network": "Red",
  "settings.nav.advanced": "Avanzado",
  "settings.general.desc": "Idioma y sonido.",
  "settings.languageHelp": "Al cambiarlo, la app se recarga en el nuevo idioma.",
  "settings.sounds": "Sonidos",
  "settings.soundsHelp":
    "Sonidos de aviso para ejecuciones y riesgo de liquidación, cuando llegue el trading.",
  "settings.wallets.desc":
    "Sigue cualquier cuenta en solo lectura. Las claves de trading llegan con la colocación de órdenes.",
  "settings.watched": "Cuenta seguida",
  "settings.watchedHelp": "Solo lectura: saldos, posiciones y órdenes abiertas, sin firmar.",
  "settings.noWatched": "Todavía no sigues ninguna cuenta.",
  "settings.copyAddress": "Copiar dirección",
  "settings.copied": "Copiada",
  "settings.keys": "Claves de trading",
  "settings.keysNone": "No hay claves en este dispositivo.",
  "settings.keysHelp":
    "Las claves solo de trading llegan con la colocación de órdenes. Se guardan solo en el llavero del sistema y no pueden retirar fondos.",
  "settings.safeguards": "Protecciones de firma",
  "settings.safeguardsHelp":
    "Touch ID antes de firmar, bloqueo por inactividad y confirmación de órdenes grandes llegan con la colocación de órdenes.",
  "settings.trading.desc":
    "Tamaño de orden, slippage y apalancamiento por defecto. Llega con la colocación de órdenes.",
  "settings.hotkeys.desc":
    "Atajos de teclado para colocar y cancelar órdenes. Llega con la colocación de órdenes.",
  "settings.notifications.desc": "Avisos de ejecuciones y riesgo de liquidación.",
  "settings.network.desc": "Endpoints de los exchanges y estado de conexión.",
  "settings.appearance.desc":
    "Tema, colores del mercado y la disposición del libro de órdenes y las operaciones.",
  "settings.bookView": "Vista del libro de órdenes",
  "settings.tradesView": "Vista de operaciones",
  "settings.advanced.desc":
    "Restablece lo que recuerda este dispositivo. Nada de aquí afecta a las claves ni a los exchanges.",
  "settings.resetLayout": "Restablecer diseño",
  "settings.resetLayoutHelp": "Vuelve a colocar los paneles en la disposición predeterminada.",
  "settings.clearWatchlist": "Vaciar favoritos",
  "settings.clearWatchlistHelp": "Quita la estrella de todos los mercados.",
  "settings.resetAll": "Restablecer todas las preferencias",
  "settings.resetAllHelp":
    "Tema, idioma, diseños, favoritos y cuenta seguida vuelven a los valores predeterminados y la app se recarga.",
  "settings.resetAllButton": "Restablecer todo",
  "settings.confirm": "Haz clic otra vez para confirmar",
  "settings.doneFeedback": "Hecho",
  "settings.marketColors": "Colores del mercado",
  "colors.standard": "Verde / rojo",
  "colors.standardDesc": "Colores de mercado estándar",
  "colors.colorblind": "Azul / naranja",
  "colors.colorblindDesc": "Más fáciles de distinguir con daltonismo",

  "layout.editor": "Editor de diseño",
  "layout.editing": "Editando el diseño",
  "layout.hint": "Arrastra los títulos para mover · arrastra los bordes para redimensionar",
  "layout.saveAs": "Guardar como…",
  "layout.done": "Listo",
  "layout.name": "Nombre del diseño",
  "layout.nameTaken": "Ese nombre pertenece a un diseño integrado",
  "layout.delete": "Eliminar el diseño {name}",
  "preset.Default": "Predeterminado",
  "preset.Scalping": "Scalping",
  "preset.Swing": "Swing",
  "palette.title": "Paneles",
  "palette.help":
    "Arrastra a la cuadrícula o haz clic para añadir al final. Un panel puede aparecer más de una vez.",
  "palette.inLayout": "en el diseño",

  "wallet.connect": "Conectar wallet",
  "wallet.close": "Cerrar",
  "wallet.watchingAddress": "Siguiendo {address}",
  "wallet.wc": "WalletConnect",
  "wallet.wcDetail": "Escanea un código QR con la wallet de tu móvil",
  "wallet.ledger": "Ledger",
  "wallet.ledgerDetail": "Wallet de hardware por USB",
  "wallet.api": "Importar wallet de API",
  "wallet.apiDetail": "Usa una clave de agente que ya aprobaste",
  "wallet.watch": "Seguir dirección",
  "wallet.watchDetail": "Solo lectura, sin firmar",
  "wallet.soon": "Aún no disponible",
  "wallet.note":
    "Para operar hace falta una clave solo de trading por exchange, que llegará con la colocación de órdenes. Mientras tanto, sigue cualquier dirección para ver sus posiciones y órdenes.",
  "wallet.watchTitle": "Seguir una dirección",
  "wallet.watchHelp":
    "Consulta los saldos, posiciones y órdenes abiertas de cualquier cuenta sin firmar nada. Desde aquí no se puede operar.",
  "wallet.stopWatching": "Dejar de seguir",
  "wallet.watchAnother": "Seguir otra dirección",
  "wallet.address": "Dirección",
  "wallet.invalid": "No es una dirección: se esperaba 0x seguido de 40 caracteres hexadecimales.",
  "wallet.footer":
    "Pewterdesk nunca ve tu frase semilla. Las conexiones van directamente de este dispositivo a cada exchange.",

  "error.noTauri":
    "Los datos del exchange requieren la app de escritorio: ejecuta `make dev`, no `make dev-ui`.",
  "error.failed": "La llamada al exchange falló.",
  "error.unsupported": "No compatible: {detail}",
  "error.invalidRequest": "Solicitud no válida: {detail}",
  "error.rejected": "Rechazado por el exchange: {detail}",
  "error.network": "Error de red: {detail}",
  "error.noKey": "No hay ninguna clave guardada para esta cuenta.",
  "error.key": "Error de clave: {detail}",
  "error.feedClosed": "El exchange cerró el flujo.",
};
