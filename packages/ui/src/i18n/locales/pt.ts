import type { Messages } from "./en";

// Portuguese (Brazil).
export const messages: Messages = {
  "col.price": "Preço",
  "col.size": "Tamanho",
  "col.total": "Total",
  "col.time": "Hora",
  "col.market": "Mercado",
  "col.side": "Lado",
  "col.type": "Tipo",
  "col.filled": "Executado",
  "col.trigger": "Gatilho",
  "col.reduceOnly": "Somente redução",
  "col.status": "Status",
  "col.entry": "Entrada",
  "col.mark": "Marcação",
  "col.liq": "Liq.",
  "col.upnl": "PnL não realizado (ROE)",
  "col.margin": "Margem",
  "col.maxLeverage": "Alavancagem máx.",
  "col.tickSize": "Tick",
  "col.sizeStep": "Passo de tamanho",
  "col.minSize": "Tamanho mín.",

  "side.buy": "Compra",
  "side.sell": "Venda",
  "side.long": "Long",
  "side.short": "Short",
  "side.bid": "Oferta de compra",
  "side.ask": "Oferta de venda",
  "common.yes": "Sim",
  "common.no": "Não",
  "orderType.market": "Mercado",
  "orderType.limit": "Limite",
  "orderType.trigger": "Condicional",
  "orderStatus.pending": "Pendente",
  "orderStatus.open": "Aberta",
  "orderStatus.filled": "Executada",
  "orderStatus.cancelled": "Cancelada",
  "orderStatus.rejected": "Rejeitada",

  "hint.unit": "Em {asset}.",
  "hint.book.price":
    "Preço limite das ordens neste nível. Ofertas de venda (vendedores) ficam acima do spread e as de compra (compradores), abaixo.",
  "hint.book.size": "Tudo o que está exatamente neste preço.",
  "hint.book.total":
    "Tamanho acumulado do spread até este nível — o que uma ordem a mercado teria de consumir para chegar aqui. A barra sombreada mostra a mesma coisa.",
  "hint.trades.price":
    "Preço em que a negociação foi executada. Verde quando um comprador pegou uma oferta de venda, vermelho quando um vendedor bateu em uma de compra.",
  "hint.trades.size": "Quanto mudou de mãos.",
  "hint.trades.time": "Quando a negociação aconteceu, no seu horário local.",

  "tip.sizeHere": "Tamanho aqui",
  "tip.valueHere": "Valor aqui",
  "tip.totalToHere": "Total até aqui",
  "tip.valueToHere": "Valor até aqui",
  "tip.avgFill": "Preço médio de execução",
  "tip.fromMid": "Distância do preço médio",
  "tip.value": "Valor",
  "tip.tradeBuy": "Compra — o tomador pegou uma oferta de venda",
  "tip.tradeSell": "Venda — o tomador bateu em uma oferta de compra",

  "book.spread": "spread {spread} · {bps} bps",
  "book.ratio": "Compras {bids}, vendas {asks}",
  "book.ratioBid": "C",
  "book.ratioAsk": "V",
  "book.loading": "Carregando o livro de ofertas",
  "trades.loading": "Carregando negociações",
  "trades.empty": "Ainda não há negociações.",

  "account.equity": "Patrimônio",
  "account.upnl": "PnL não realizado",
  "account.marginUsed": "Margem usada",
  "account.available": "Disponível",
  "account.marginRatio": "Índice de margem",
  "positions.empty": "Nenhuma posição aberta.",
  "orders.empty": "Nenhuma ordem aberta.",

  "markets.search": "Buscar mercados",
  "markets.show": "Mostrar",
  "markets.all": "Todos",
  "markets.watchlist": "Favoritos ({count})",
  "markets.watchlistColumn": "Favoritos",
  "markets.watchlistEmpty":
    "Seus favoritos estão vazios. Marque um mercado com a estrela para adicioná-lo.",
  "markets.noMatch": "Nenhum mercado corresponde a “{query}”.",
  "star.add": "Adicionar {name} aos favoritos",
  "star.remove": "Remover {name} dos favoritos",

  "panel.markets": "Mercados",
  "panel.orderBook": "Livro de ofertas",
  "panel.account": "Conta",
  "panel.positions": "Posições",
  "panel.remove": "Remover {panel}",
  "tab.orderBook": "Livro de ofertas",
  "tab.trades": "Negociações",
  "tab.positions": "Posições",
  "tab.openOrders": "Ordens abertas",
  "menu.view": "Visualização",
  "menu.bookOptions": "Opções do livro de ofertas",
  "menu.tradesOptions": "Opções de negociações",
  "view.table": "Tabela",
  "view.tableDesc": "Uma linha por item, em colunas",
  "view.stacked": "Empilhada",
  "view.stackedDesc": "Duas linhas por item, mais fácil de ler",

  "feed.loading": "Carregando…",
  "feed.closed": "Fluxo encerrado — mostrando a última atualização.",
  "feed.pickMarket": "Escolha um mercado.",
  "feed.noAccount": "Nenhuma conta para mostrar.",
  "feed.connectToWatch":
    "Conecte uma carteira (canto superior direito) para acompanhar uma conta. Somente leitura — nenhuma chave necessária.",

  "header.mid": "Médio",

  "header.home": "Ir para o trading",

  // Market stats bar

  "stats.chooseMarket": "Escolha um mercado",

  "stats.marketInfo": "{venue} · até {leverage}x · tick {tick} · tamanho mín. {min}",

  "stats.markHint": "Preço de marcação: o que margem, PnL e liquidações usam.",

  "stats.mid": "Preço médio",

  "stats.midHint": "Ponto médio entre a melhor compra e a melhor venda.",

  "stats.index": "Preço do índice",

  "stats.indexHint": "O preço do oráculo que a marcação acompanha.",

  "stats.change": "Variação 24h",

  "stats.high": "Máxima 24h",

  "stats.low": "Mínima 24h",

  "stats.volume": "Volume 24h ({asset})",

  "stats.openInterest": "Contratos em aberto ({asset})",

  "stats.funding": "Funding / contagem regressiva",

  "stats.fundingHint":
    "Pago a cada {hours} h entre longs e shorts. Positivo: longs pagam shorts; negativo: shorts pagam longs.",

  "stats.loading": "Carregando estatísticas do mercado",
  "header.upTo": "até {leverage}x",
  "action.editLayout": "Editar layout",
  "action.doneLayout": "Concluir edição do layout",
  "action.mute": "Silenciar sons",
  "action.unmute": "Ativar sons",
  "action.settings": "Configurações",
  "action.language": "Idioma: {language}",
  "menu.language": "Idioma",
  "menu.theme": "Tema",
  "action.theme": "Tema: {theme}",
  "theme.dark.name": "Estanho",
  "theme.dark.desc": "Estanho e latão sobre quase preto",
  "theme.graphite.name": "Grafite",
  "theme.graphite.desc": "Mais frio e um tom mais claro",
  "theme.synthwave.name": "Synthwave '84",
  "theme.synthwave.desc": "Rosa neon sobre roxo retrô",
  "theme.monokai.name": "Monokai Pro",
  "theme.monokai.desc": "Filtro Machine: amarelo sobre cinza frio",
  "theme.palenight.name": "Palenight",
  "theme.palenight.desc": "Roxo suave sobre azul-ardósia",
  "theme.parchment.name": "Pergaminho",
  "theme.parchment.desc": "Claro e quente, tom de papel",

  // Settings page
  "settings.title": "Configurações",
  "settings.back": "Voltar ao trading",
  "settings.soon": "Em breve",
  "settings.comingSoon": "Ainda não disponível",
  "settings.nav.general": "Geral",
  "settings.nav.wallets": "Carteiras e chaves",
  "settings.nav.trading": "Trading",
  "settings.nav.hotkeys": "Atalhos",
  "settings.nav.notifications": "Notificações",
  "settings.nav.appearance": "Aparência",
  "settings.nav.network": "Rede",
  "settings.nav.advanced": "Avançado",
  "settings.general.desc": "Idioma e som.",
  "settings.languageHelp": "Ao trocar, o app é recarregado no novo idioma.",
  "settings.sounds": "Sons",
  "settings.soundsHelp":
    "Sons de alerta para execuções e risco de liquidação, quando o trading chegar.",
  "settings.wallets.desc":
    "Acompanhe qualquer conta em modo somente leitura. As chaves de negociação chegam com o envio de ordens.",
  "settings.watched": "Conta acompanhada",
  "settings.watchedHelp": "Somente leitura: saldos, posições e ordens abertas, sem assinatura.",
  "settings.noWatched": "Nenhuma conta acompanhada ainda.",
  "settings.copyAddress": "Copiar endereço",
  "settings.copied": "Copiado",
  "settings.keys": "Chaves de negociação",
  "settings.keysNone": "Nenhuma chave neste dispositivo.",
  "settings.keysHelp":
    "As chaves só de negociação chegam com o envio de ordens. Ficam apenas no chaveiro do sistema e não podem sacar.",
  "settings.safeguards": "Proteções de assinatura",
  "settings.safeguardsHelp":
    "Touch ID antes de assinar, bloqueio por inatividade e confirmação de ordens grandes chegam com o envio de ordens.",
  "settings.trading.desc":
    "Tamanho de ordem, slippage e alavancagem padrão. Chega com o envio de ordens.",
  "settings.hotkeys.desc":
    "Atalhos de teclado para enviar e cancelar ordens. Chega com o envio de ordens.",
  "settings.notifications.desc": "Alertas de execuções e risco de liquidação.",
  "settings.network.desc": "Endpoints das corretoras e status da conexão.",
  "settings.appearance.desc":
    "Tema, cores do mercado e o layout do livro de ofertas e das negociações.",
  "settings.bookView": "Visualização do livro de ofertas",
  "settings.tradesView": "Visualização das negociações",
  "settings.advanced.desc":
    "Redefina o que este dispositivo lembra. Nada aqui afeta chaves ou corretoras.",
  "settings.resetLayout": "Redefinir layout",
  "settings.resetLayoutHelp": "Volta os painéis ao arranjo padrão.",
  "settings.clearWatchlist": "Limpar favoritos",
  "settings.clearWatchlistHelp": "Remove a estrela de todos os mercados.",
  "settings.resetAll": "Redefinir todas as preferências",
  "settings.resetAllHelp":
    "Tema, idioma, layouts, favoritos e conta acompanhada voltam ao padrão, e o app é recarregado.",
  "settings.resetAllButton": "Redefinir tudo",
  "settings.confirm": "Clique de novo para confirmar",
  "settings.doneFeedback": "Feito",
  "settings.marketColors": "Cores do mercado",
  "colors.standard": "Verde / vermelho",
  "colors.standardDesc": "Cores de mercado padrão",
  "colors.colorblind": "Azul / laranja",
  "colors.colorblindDesc": "Mais fáceis de distinguir com daltonismo",

  "layout.editor": "Editor de layout",
  "layout.editing": "Editando o layout",
  "layout.hint": "Arraste os títulos para mover · arraste as bordas para redimensionar",
  "layout.saveAs": "Salvar como…",
  "layout.done": "Concluir",
  "layout.name": "Nome do layout",
  "layout.nameTaken": "Esse nome pertence a um layout integrado",
  "layout.delete": "Excluir o layout {name}",
  "preset.Default": "Padrão",
  "preset.Scalping": "Scalping",
  "preset.Swing": "Swing",
  "palette.title": "Painéis",
  "palette.help":
    "Arraste para a grade ou clique para adicionar no final. Um painel pode aparecer mais de uma vez.",
  "palette.inLayout": "no layout",

  "wallet.connect": "Conectar carteira",
  "wallet.close": "Fechar",
  "wallet.watchingAddress": "Acompanhando {address}",
  "wallet.wc": "WalletConnect",
  "wallet.wcDetail": "Escaneie um QR code com a carteira do celular",
  "wallet.ledger": "Ledger",
  "wallet.ledgerDetail": "Carteira de hardware via USB",
  "wallet.api": "Importar carteira de API",
  "wallet.apiDetail": "Use uma chave de agente que você já aprovou",
  "wallet.watch": "Acompanhar endereço",
  "wallet.watchDetail": "Somente leitura, sem assinatura",
  "wallet.soon": "Ainda não disponível",
  "wallet.note":
    "Para negociar é preciso uma chave só de negociação por corretora, que chega junto com o envio de ordens. Até lá, acompanhe qualquer endereço para ver suas posições e ordens.",
  "wallet.watchTitle": "Acompanhar um endereço",
  "wallet.watchHelp":
    "Veja saldos, posições e ordens abertas de qualquer conta sem assinar nada. Nada aqui pode negociar.",
  "wallet.stopWatching": "Parar de acompanhar",
  "wallet.watchAnother": "Acompanhar outro endereço",
  "wallet.address": "Endereço",
  "wallet.invalid": "Isso não é um endereço — esperado 0x seguido de 40 caracteres hexadecimais.",
  "wallet.footer":
    "O Pewterdesk nunca vê sua frase-semente. As conexões vão direto deste dispositivo para cada corretora.",

  "error.noTauri":
    "Os dados da corretora exigem o app de desktop — execute `make dev`, não `make dev-ui`.",
  "error.failed": "A chamada à corretora falhou.",
  "error.unsupported": "Não suportado: {detail}",
  "error.invalidRequest": "Solicitação inválida: {detail}",
  "error.rejected": "Rejeitado pela corretora: {detail}",
  "error.network": "Erro de rede: {detail}",
  "error.noKey": "Nenhuma chave salva para esta conta.",
  "error.key": "Erro de chave: {detail}",
  "error.feedClosed": "A corretora encerrou o fluxo.",
};
