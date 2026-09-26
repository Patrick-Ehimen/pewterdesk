import type { Messages } from "./en";

// Japanese.
export const messages: Messages = {
  "col.price": "価格",
  "col.size": "数量",
  "col.total": "累計",
  "col.time": "時刻",
  "col.market": "銘柄",
  "col.side": "売買",
  "col.type": "種類",
  "col.filled": "約定",
  "col.trigger": "トリガー",
  "col.reduceOnly": "決済のみ",
  "col.status": "状態",
  "col.entry": "建値",
  "col.mark": "マーク価格",
  "col.liq": "清算価格",
  "col.upnl": "含み損益 (ROE)",
  "col.margin": "証拠金",
  "col.maxLeverage": "最大レバレッジ",
  "col.tickSize": "呼値",
  "col.sizeStep": "数量単位",
  "col.minSize": "最小数量",

  "side.buy": "買い",
  "side.sell": "売り",
  "side.long": "ロング",
  "side.short": "ショート",
  "side.bid": "買い気配",
  "side.ask": "売り気配",
  "common.yes": "はい",
  "common.no": "いいえ",
  "orderType.market": "成行",
  "orderType.limit": "指値",
  "orderType.trigger": "逆指値",
  "orderStatus.pending": "保留中",
  "orderStatus.open": "未約定",
  "orderStatus.filled": "約定済み",
  "orderStatus.cancelled": "取消済み",
  "orderStatus.rejected": "拒否",

  "hint.unit": "単位：{asset}。",
  "hint.book.price":
    "この価格帯に並ぶ注文の指値です。売り気配（売り手）はスプレッドの上、買い気配（買い手）は下にあります。",
  "hint.book.size": "ちょうどこの価格に並んでいる数量の合計です。",
  "hint.book.total":
    "スプレッドからこの価格帯までの累計数量です。成行注文がここまで届くために消化する板の厚みにあたります。網掛けのバーも同じ内容を示します。",
  "hint.trades.price":
    "約定した価格です。買い手が売り気配を取ると緑、売り手が買い気配に当てると赤で表示します。",
  "hint.trades.size": "取引された数量です。",
  "hint.trades.time": "約定した時刻です（現地時間）。",

  "tip.sizeHere": "この価格の数量",
  "tip.valueHere": "この価格の金額",
  "tip.totalToHere": "ここまでの累計数量",
  "tip.valueToHere": "ここまでの累計金額",
  "tip.avgFill": "平均約定価格",
  "tip.fromMid": "仲値との差",
  "tip.value": "金額",
  "tip.tradeBuy": "買い — テイカーが売り気配を取得",
  "tip.tradeSell": "売り — テイカーが買い気配に売却",

  "book.spread": "スプレッド {spread} · {bps} bps",
  "book.ratio": "買い {bids}、売り {asks}",
  "book.ratioBid": "買",
  "book.ratioAsk": "売",
  "book.loading": "板情報を読み込み中",
  "trades.loading": "約定履歴を読み込み中",
  "trades.empty": "まだ約定はありません。",

  "account.equity": "資産",
  "account.upnl": "含み損益",
  "account.marginUsed": "使用証拠金",
  "account.available": "利用可能",
  "account.marginRatio": "証拠金率",
  "positions.empty": "保有ポジションはありません。",
  "orders.empty": "未約定の注文はありません。",

  "markets.search": "銘柄を検索",
  "markets.show": "表示",
  "markets.all": "すべて",
  "markets.watchlist": "ウォッチリスト ({count})",
  "markets.watchlistColumn": "ウォッチリスト",
  "markets.watchlistEmpty": "ウォッチリストは空です。銘柄の星をクリックして追加しましょう。",
  "markets.noMatch": "「{query}」に一致する銘柄はありません。",
  "star.add": "{name} をウォッチリストに追加",
  "star.remove": "{name} をウォッチリストから削除",

  "panel.markets": "銘柄",
  "panel.orderBook": "板情報",
  "panel.account": "口座",
  "panel.positions": "ポジション",
  "panel.remove": "{panel}を削除",
  "tab.orderBook": "板情報",
  "tab.trades": "約定履歴",
  "tab.positions": "ポジション",
  "tab.openOrders": "未約定注文",
  "menu.view": "表示",
  "menu.bookOptions": "板情報のオプション",
  "menu.tradesOptions": "約定履歴のオプション",
  "view.table": "テーブル",
  "view.tableDesc": "1 行に 1 件、列で表示",
  "view.stacked": "スタック",
  "view.stackedDesc": "1 件を 2 行で表示、見やすい",

  "feed.loading": "読み込み中…",
  "feed.closed": "フィードが終了しました — 最後の更新を表示しています。",
  "feed.pickMarket": "銘柄を選択してください。",
  "feed.noAccount": "表示する口座がありません。",
  "feed.connectToWatch":
    "ウォレットを接続すると（右上）口座を閲覧できます。閲覧のみ — 鍵は不要です。",

  "header.mid": "仲値",

  "header.home": "取引画面へ",

  // Pages and navigation

  "nav.menu": "ページ",

  "nav.trade": "取引",

  "nav.tradeDesc": "銘柄・板情報・ポジション",

  "nav.portfolio": "ポートフォリオ",

  "nav.portfolioDesc": "口座の残高とエクスポージャー",

  "nav.journal": "ジャーナル",

  "nav.journalDesc": "取引にタグを付けて振り返る",

  "nav.news": "ニュース",

  "nav.newsDesc": "取引所・オンチェーン・マクロのヘッドライン",

  "nav.settingsDesc": "設定・ウォレット・鍵",

  "portfolio.subtitle": "閲覧中の口座 · 閲覧のみ",

  "portfolio.empty":
    "ウォレットを接続するとポートフォリオを表示できます。閲覧のみ — 鍵は不要です。",

  "portfolio.equityNote": "{venue} の {quote}",

  "portfolio.positionsNote": "保有ポジション：{count}",

  "portfolio.marginNote": "資産の {percent}",

  "portfolio.gross": "グロスエクスポージャー",

  "portfolio.grossNote": "資産の {ratio} 倍",

  "portfolio.net": "ネットエクスポージャー",

  "portfolio.netLong": "ロング寄り",

  "portfolio.netShort": "ショート寄り",

  "portfolio.netFlat": "フラット",

  "portfolio.byAsset": "資産別エクスポージャー",

  "portfolio.byAssetNote": "取引所をまたぐポジションはここで相殺されます",

  "portfolio.col.asset": "資産",

  "portfolio.col.venue": "取引所",

  "portfolio.col.netSize": "ネット数量",

  "portfolio.col.netNotional": "ネット想定元本",

  "portfolio.col.share": "グロスに占める割合",

  "portfolio.byVenue": "取引所別",

  "portfolio.byVenueNote": "dYdX・Drift・GMX はアダプターの追加後にここに表示されます。",

  "journal.subtitle": "この端末にのみ保存 · アップロードしません",

  "journal.soon":
    "ジャーナルは各約定をタグとメモとともに記録し、純損益、勝率、銘柄別・時間帯別の損益を表示します。約定履歴が必要で、注文機能と同時に提供予定です。",

  "news.subtitle": "アプリがお使いの端末で取得 · Pewterdesk のサーバーは使いません",

  "news.soon":
    "ニュースは取引所のお知らせ、オンチェーンアラート、経済指標カレンダーをまとめ、ソースごとにオン・オフできます。",

  // Market stats bar

  "stats.chooseMarket": "銘柄を選択",

  "stats.marketInfo": "{venue} · 最大 {leverage}x · 呼値 {tick} · 最小数量 {min}",

  "stats.markHint": "マーク価格：証拠金・損益・清算の基準です。",

  "stats.mid": "仲値",

  "stats.midHint": "最良買い気配と売り気配の中間です。",

  "stats.index": "インデックス価格",

  "stats.indexHint": "マーク価格が追随するオラクル価格です。",

  "stats.change": "24時間変動",

  "stats.high": "24時間高値",

  "stats.low": "24時間安値",

  "stats.volume": "24時間売買代金 ({asset})",

  "stats.openInterest": "建玉 ({asset})",

  "stats.funding": "資金調達率 / カウントダウン",

  "stats.fundingHint":
    "{hours} 時間ごとにロングとショートの間で支払われます。プラスならロングがショートに、マイナスならショートがロングに支払います。",

  "stats.loading": "銘柄の統計を読み込み中",
  "header.upTo": "最大 {leverage}x",
  "action.editLayout": "レイアウトを編集",
  "action.doneLayout": "レイアウトの編集を終了",
  "action.mute": "サウンドをミュート",
  "action.unmute": "サウンドのミュートを解除",
  "action.settings": "設定",
  "action.language": "言語：{language}",
  "menu.language": "言語",
  "menu.theme": "テーマ",
  "action.theme": "テーマ：{theme}",
  "theme.dark.name": "ピューター",
  "theme.dark.desc": "黒に近い地にピューターと真鍮",
  "theme.graphite.name": "グラファイト",
  "theme.graphite.desc": "少しクールで一段明るい",
  "theme.synthwave.name": "Synthwave '84",
  "theme.synthwave.desc": "レトロな紫にネオンピンク",
  "theme.monokai.name": "Monokai Pro",
  "theme.monokai.desc": "Machine フィルター：クールグレーに黄色",
  "theme.palenight.name": "Palenight",
  "theme.palenight.desc": "スレートブルーに柔らかな紫",
  "theme.parchment.name": "パーチメント",
  "theme.parchment.desc": "紙のような温かみのある明るさ",

  // Settings page
  "settings.title": "設定",
  "settings.back": "取引に戻る",
  "settings.soon": "近日対応",
  "settings.comingSoon": "未対応",
  "settings.nav.general": "一般",
  "settings.nav.wallets": "ウォレットと鍵",
  "settings.nav.trading": "取引",
  "settings.nav.hotkeys": "ショートカット",
  "settings.nav.notifications": "通知",
  "settings.nav.appearance": "表示",
  "settings.nav.network": "ネットワーク",
  "settings.nav.advanced": "詳細",
  "settings.general.desc": "言語とサウンド。",
  "settings.languageHelp": "切り替えると、新しい言語でアプリが再読み込みされます。",
  "settings.sounds": "サウンド",
  "settings.soundsHelp": "取引機能の追加後、約定や清算警告の通知音に使われます。",
  "settings.wallets.desc":
    "任意の口座を閲覧のみで確認できます。取引用の鍵は注文機能と同時に提供予定です。",
  "settings.watched": "閲覧中の口座",
  "settings.watchedHelp": "閲覧のみ：残高・ポジション・未約定注文。署名はしません。",
  "settings.noWatched": "まだ口座を閲覧していません。",
  "settings.copyAddress": "アドレスをコピー",
  "settings.copied": "コピーしました",
  "settings.keys": "取引用の鍵",
  "settings.keysNone": "この端末に鍵はありません。",
  "settings.keysHelp":
    "取引専用の鍵は注文機能と同時に提供予定です。OS のキーチェーンにのみ保存され、出金はできません。",
  "settings.safeguards": "署名の保護",
  "settings.safeguardsHelp":
    "署名前の Touch ID、アイドル時のロック、大口注文の確認は注文機能と同時に提供予定です。",
  "settings.trading.desc":
    "既定の注文数量・スリッページ・レバレッジ。注文機能と同時に提供予定です。",
  "settings.hotkeys.desc": "注文と取消のキーボードショートカット。注文機能と同時に提供予定です。",
  "settings.notifications.desc": "約定と清算リスクの通知。",
  "settings.network.desc": "取引所のエンドポイントと接続状態。",
  "settings.appearance.desc": "テーマ、相場の色、板情報と約定履歴のレイアウト。",
  "settings.bookView": "板情報の表示",
  "settings.tradesView": "約定履歴の表示",
  "settings.advanced.desc":
    "この端末に保存された設定をリセットします。鍵や取引所には影響しません。",
  "settings.resetLayout": "レイアウトをリセット",
  "settings.resetLayoutHelp": "パネルを既定の配置に戻します。",
  "settings.clearWatchlist": "ウォッチリストを消去",
  "settings.clearWatchlistHelp": "すべての銘柄の星を外します。",
  "settings.resetAll": "すべての設定をリセット",
  "settings.resetAllHelp":
    "テーマ・言語・レイアウト・ウォッチリスト・閲覧中の口座が既定に戻り、アプリが再読み込みされます。",
  "settings.resetAllButton": "すべてリセット",
  "settings.confirm": "もう一度クリックして確定",
  "settings.doneFeedback": "完了",
  "settings.marketColors": "相場の色",
  "colors.standard": "緑 / 赤",
  "colors.standardDesc": "標準の相場カラー",
  "colors.colorblind": "青 / オレンジ",
  "colors.colorblindDesc": "色覚特性があっても見分けやすい配色",

  "layout.editor": "レイアウトエディター",
  "layout.editing": "レイアウトを編集中",
  "layout.hint": "タイトルをドラッグで移動 · 端をドラッグでサイズ変更",
  "layout.saveAs": "名前を付けて保存…",
  "layout.done": "完了",
  "layout.name": "レイアウト名",
  "layout.nameTaken": "その名前は組み込みレイアウトで使われています",
  "layout.delete": "レイアウト {name} を削除",
  "preset.Default": "デフォルト",
  "preset.Scalping": "スキャルピング",
  "preset.Swing": "スイング",
  "palette.title": "パネル",
  "palette.help":
    "グリッドにドラッグするか、クリックして一番下に追加します。同じパネルを複数置けます。",
  "palette.inLayout": "配置済み",

  "wallet.connect": "ウォレットを接続",
  "wallet.close": "閉じる",
  "wallet.watchingAddress": "{address} を閲覧中",
  "wallet.wc": "WalletConnect",
  "wallet.wcDetail": "スマホのウォレットで QR コードを読み取り",
  "wallet.ledger": "Ledger",
  "wallet.ledgerDetail": "USB 接続のハードウェアウォレット",
  "wallet.api": "API ウォレットをインポート",
  "wallet.apiDetail": "承認済みのエージェントキーを使用",
  "wallet.watch": "アドレスを閲覧",
  "wallet.watchDetail": "閲覧のみ、署名なし",
  "wallet.soon": "未対応",
  "wallet.note":
    "取引には取引所ごとの取引専用キーが必要で、注文機能と同時に提供予定です。それまでは任意のアドレスのポジションと注文を閲覧できます。",
  "wallet.watchTitle": "アドレスを閲覧",
  "wallet.watchHelp":
    "署名せずに、任意の口座の残高・ポジション・未約定注文を確認できます。ここから取引はできません。",
  "wallet.stopWatching": "閲覧をやめる",
  "wallet.watchAnother": "別のアドレスを閲覧",
  "wallet.address": "アドレス",
  "wallet.invalid": "アドレスではありません — 0x に続く 16 進数 40 文字が必要です。",
  "wallet.footer":
    "Pewterdesk がシードフレーズを見ることはありません。接続はこの端末から各取引所へ直接行われます。",

  "error.noTauri":
    "取引所のデータにはデスクトップアプリが必要です — `make dev-ui` ではなく `make dev` を実行してください。",
  "error.failed": "取引所へのリクエストに失敗しました。",
  "error.unsupported": "未対応：{detail}",
  "error.invalidRequest": "無効なリクエスト：{detail}",
  "error.rejected": "取引所に拒否されました：{detail}",
  "error.network": "ネットワークエラー：{detail}",
  "error.noKey": "この口座に保存された鍵はありません。",
  "error.key": "鍵のエラー：{detail}",
  "error.feedClosed": "取引所がフィードを終了しました。",
};
