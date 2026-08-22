# -*- coding: utf-8 -*-
HEAD='''<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>'''
TAIL='''</x-dc>
</body>
</html>'''

STYLES = {
 'A': dict(name='台帳', bg='#f5f2ec', fg='#1b1a18', muted='#6b6860', rule='#d8d4cc', brand='#26364a', brandfg='#f5f2ec', acc='#d8b86a', acc2='#8a6a24',
   fonts='Shippori+Mincho:wght@500;700;800&family=BIZ+UDPGothic:wght@400;700', head="'Shippori Mincho','Hiragino Mincho ProN',serif", body="'BIZ UDPGothic','Hiragino Sans',sans-serif",
   hw=800, yes='background:#d9ebe8;color:#1e5552;border:1px solid #b6d6d2;', no='background:#efe0ea;color:#663a5c;border:1px solid #d9bdd0;', none='background:#ebe8e1;color:#6b6860;border:1px dashed #b9b3a8;', act='background:#f1e8d3;color:#6a4e12;border:1px solid #dccaa0;', radius='0', link='#3a4a5e', btn='border:1px solid #26364a;color:#26364a;'),
 'B': dict(name='大胆な色面', bg='#ffffff', fg='#15201f', muted='#5b6664', rule='#e6e9e8', brand='#0e6b66', brandfg='#ffffff', acc='#ffffff', acc2='#0a4f4b',
   fonts='Zen+Kaku+Gothic+New:wght@500;700;900', head="'Zen Kaku Gothic New','Hiragino Sans',sans-serif", body="'Zen Kaku Gothic New','Hiragino Sans',sans-serif",
   hw=900, yes='background:#15201f;color:#fff;', no='border:2.5px solid #15201f;color:#15201f;', none='border:2.5px dashed #9aa3a2;color:#6b7574;', act='background:#e4f1ef;color:#0a4f4b;', radius='0', link='#0e6b66', btn='background:#15201f;color:#fff;'),
 'C': dict(name='夜の台帳', bg='#1c1d21', fg='#ece8df', muted='#9a978f', rule='#34363c', brand='#1c1d21', brandfg='#ece8df', acc='#d8b86a', acc2='#d8b86a',
   fonts='Shippori+Mincho:wght@500;700;800&family=BIZ+UDPGothic:wght@400;700', head="'Shippori Mincho','Hiragino Mincho ProN',serif", body="'BIZ UDPGothic','Hiragino Sans',sans-serif",
   hw=800, yes='background:#ece8df;color:#1c1d21;', no='border:1.5px solid #ece8df;color:#ece8df;', none='border:1.5px dashed #6b6a65;color:#9a978f;', act='border:1.5px solid #d8b86a;color:#d8b86a;', radius='0', link='#d8b86a', btn='border:1px solid #d8b86a;color:#d8b86a;'),
 'D': dict(name='ポスター', bg='#fbf7ef', fg='#14110f', muted='#6a635a', rule='#14110f', brand='#5c2a52', brandfg='#fbf7ef', acc='#e0a62b', acc2='#5c2a52',
   fonts='Noto+Serif+JP:wght@600;900&family=Noto+Sans+JP:wght@400;700', head="'Noto Serif JP','Hiragino Mincho ProN',serif", body="'Noto Sans JP','Hiragino Sans',sans-serif",
   hw=900, yes='background:#14110f;color:#fbf7ef;', no='background:#fbf7ef;color:#14110f;border:2px solid #14110f;', none='color:#6a635a;border:2px dashed #b9b1a4;', act='background:#e0a62b;color:#14110f;', radius='999px', link='#5c2a52', btn='background:#5c2a52;color:#fbf7ef;'),
 'E': dict(name='計器盤', bg='#f3f4f6', fg='#111318', muted='#6b7280', rule='#d6d9e0', brand='#ffffff', brandfg='#111318', acc='#4f46e5', acc2='#4f46e5',
   fonts='IBM+Plex+Sans+JP:wght@400;500;700&family=IBM+Plex+Mono:wght@500;600', head="'IBM Plex Sans JP','Hiragino Sans',sans-serif", body="'IBM Plex Sans JP','Hiragino Sans',sans-serif",
   hw=700, yes='background:#111318;color:#fff;', no='background:#fff;color:#111318;border:1.5px solid #111318;', none='background:#e5e7eb;color:#6b7280;', act='background:#e0e7ff;color:#3730a3;', radius='4px', link='#4f46e5', btn='background:#4f46e5;color:#fff;'),
}

def helmet(s):
    mono = "font-family:'IBM Plex Mono',monospace;" if s['name']=='計器盤' else ''
    return f'''<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family={s['fonts']}&display=swap">
  <style>
    body {{ margin:0; background:{s['bg']}; color:{s['fg']}; font-family:{s['body']}; -webkit-font-smoothing:antialiased; }}
    a {{ color:{s['link']}; text-decoration:none; border-bottom:1px solid {s['link']}; }} a:hover {{ color:{s['fg']}; border-bottom-color:{s['fg']}; }}
    .h {{ font-family:{s['head']}; }}
    .num {{ font-variant-numeric:tabular-nums; {mono} }}
    .stamp {{ font-family:{s['head']}; font-weight:700; font-size:13px; letter-spacing:0.06em; width:48px; height:26px; display:flex; align-items:center; justify-content:center; flex-shrink:0; border-radius:{s['radius']}; }}
  </style>
</helmet>'''

def stamp(s,kind):
    lab={'yes':'賛成','no':'反対','none':'－','spk':'発言','sub':'提出'}[kind]
    st=s[kind] if kind in ('yes','no','none') else s['act']
    return f'<div class="stamp" style="{st}">{lab}</div>'

def item(s,kind,title,meta):
    return f'''<div style="display:flex; gap:12px; padding:12px 0; border-bottom:1px solid {s['rule']}; align-items:flex-start;">
  {stamp(s,kind)}
  <div style="flex:1; display:flex; flex-direction:column; gap:4px;">
    <div style="font-size:14.5px; line-height:1.5;">{title}</div>
    <div style="font-size:12px; color:{s['muted']}; line-height:1.5;">{meta}</div>
  </div>
</div>'''

def member_page(s):
    brand_on = s['name'] in ('台帳','大胆な色面','ポスター','夜の台帳')
    hb = s['brand'] if brand_on else s['bg']
    hf = s['brandfg'] if brand_on else s['fg']
    hmuted = 'rgba(255,255,255,0.72)' if brand_on and s['name']!='夜の台帳' else s['muted']
    if s['name']=='夜の台帳': hmuted=s['muted']
    acc = s['acc']
    if s['name']=='計器盤':
        header=f'''<div style="background:#fff; border-bottom:1px solid {s['rule']}; padding:14px 20px 0; display:flex; flex-direction:column;">
  <div style="display:flex; justify-content:space-between; font-size:12px; color:{s['muted']};"><a href="#" style="border:none;">← 議員</a><div class="num">UPDATED 2026-08-22 06:00</div></div>
  <div style="padding:18px 0 0; display:flex; flex-direction:column; gap:4px;">
    <div class="num" style="font-size:11px; color:{s['acc']}; letter-spacing:0.1em;">HC ・ 7007123 ・ ふじかわ まさひと</div>
    <div class="h" style="font-size:34px; font-weight:700; line-height:1.1;">藤川 政人</div>
    <div style="font-size:13px; color:{s['muted']};">参議院 ・ 愛知 ・ 自由民主党・無所属の会 ・ 在職 <span class="num">2010—</span> 3期</div>
  </div>
  <div style="margin-top:16px; display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:8px; padding-bottom:16px;">
    <div style="background:{s['bg']}; border:1px solid {s['rule']}; border-radius:4px; padding:10px;"><div class="num" style="font-size:24px; font-weight:600;">312</div><div style="font-size:11px; color:{s['muted']};">記名採決</div></div>
    <div style="background:{s['bg']}; border:1px solid {s['rule']}; border-radius:4px; padding:10px;"><div class="num" style="font-size:24px; font-weight:600;">4</div><div style="font-size:11px; color:{s['muted']};">提出法案</div></div>
    <div style="background:{s['bg']}; border:1px solid {s['rule']}; border-radius:4px; padding:10px;"><div class="num" style="font-size:24px; font-weight:600;">27</div><div style="font-size:11px; color:{s['muted']};">本会議発言</div></div>
  </div>
</div>
<div style="padding:0 20px; background:#fff; display:flex; border-bottom:1px solid {s['rule']};">
  <div style="flex:1; padding:12px 0 10px; text-align:center; font-size:13px; font-weight:700; color:{s['acc']}; border-bottom:2px solid {s['acc']};">すべて</div>
  <div style="flex:1; padding:12px 0 10px; text-align:center; font-size:13px; color:{s['muted']};">採決</div>
  <div style="flex:1; padding:12px 0 10px; text-align:center; font-size:13px; color:{s['muted']};">提出法案</div>
  <div style="flex:1; padding:12px 0 10px; text-align:center; font-size:13px; color:{s['muted']};">発言</div>
</div>'''
    elif s['name']=='ポスター':
        header=f'''<div style="background:{s['brand']}; color:{s['brandfg']}; padding:14px 20px 0; display:flex; flex-direction:column;">
  <div style="display:flex; justify-content:space-between; font-size:12px; font-weight:700;"><a href="#" style="border:none; color:{s['brandfg']};">← 議員をさがす</a><div class="num">2026.08.22</div></div>
  <div style="padding:30px 0 0; display:flex; flex-direction:column; gap:4px;">
    <div style="font-size:12px; letter-spacing:0.25em; color:{s['acc']}; font-weight:700;">ふじかわ まさひと</div>
    <div class="h" style="font-size:52px; font-weight:900; line-height:1.0; letter-spacing:-0.02em;">藤川<br>政人</div>
    <div style="font-size:14px; font-weight:700; margin-top:14px;">参議院 ・ 愛知<br>自由民主党・無所属の会</div>
  </div>
  <div style="margin:22px -20px 0; padding:16px 20px; background:{s['acc']}; color:{s['fg']}; display:flex;">
    <div style="flex:1;"><div class="h num" style="font-size:30px; font-weight:900; line-height:1;">312</div><div style="font-size:11px; font-weight:700;">記名採決</div></div>
    <div style="flex:1;"><div class="h num" style="font-size:30px; font-weight:900; line-height:1;">4</div><div style="font-size:11px; font-weight:700;">提出法案</div></div>
    <div style="flex:1;"><div class="h num" style="font-size:30px; font-weight:900; line-height:1;">27</div><div style="font-size:11px; font-weight:700;">本会議発言</div></div>
  </div>
</div>
<div style="padding:0 20px; display:flex; border-bottom:2px solid {s['fg']};">
  <div style="flex:1; padding:12px 0 10px; text-align:center; font-size:14px; font-weight:900; border-bottom:4px solid {s['fg']};">すべて</div>
  <div style="flex:1; padding:12px 0 10px; text-align:center; font-size:14px; font-weight:700; color:{s['muted']};">採決</div>
  <div style="flex:1; padding:12px 0 10px; text-align:center; font-size:14px; font-weight:700; color:{s['muted']};">提出法案</div>
  <div style="flex:1; padding:12px 0 10px; text-align:center; font-size:14px; font-weight:700; color:{s['muted']};">発言</div>
</div>'''
    else: # 夜の台帳
        header=f'''<div style="padding:14px 20px 0; display:flex; flex-direction:column;">
  <div style="display:flex; justify-content:space-between; font-size:12px; color:{s['muted']};"><a href="#" style="border:none; color:{s['muted']};">← 議員をさがす</a><div class="num">更新 2026.08.22</div></div>
  <div style="padding:20px 0 0; display:flex; flex-direction:column; gap:4px;">
    <div style="font-size:12px; letter-spacing:0.2em; color:{s['acc']};">ふじかわ まさひと</div>
    <div class="h" style="font-size:40px; font-weight:800; line-height:1.05; letter-spacing:0.04em;">藤川 政人</div>
    <div style="font-size:14px; margin-top:6px; color:{s['fg']};">参議院 ・ 愛知 ・ 自由民主党・無所属の会</div>
    <div class="num" style="font-size:13px; color:{s['muted']};">在職 2010 —　3期　任期満了 2028.07</div>
  </div>
  <div style="margin-top:18px; padding:14px 0; border-top:1.5px solid {s['acc']}; border-bottom:1px solid {s['rule']}; display:flex;">
    <div style="flex:1;"><div class="h num" style="font-size:28px; font-weight:700; line-height:1;">312</div><div style="font-size:11px; color:{s['muted']}; letter-spacing:0.1em;">記名採決</div></div>
    <div style="flex:1; border-left:1px solid {s['rule']}; padding-left:14px;"><div class="h num" style="font-size:28px; font-weight:700; line-height:1;">4</div><div style="font-size:11px; color:{s['muted']}; letter-spacing:0.1em;">提出法案</div></div>
    <div style="flex:1; border-left:1px solid {s['rule']}; padding-left:14px;"><div class="h num" style="font-size:28px; font-weight:700; line-height:1;">27</div><div style="font-size:11px; color:{s['muted']}; letter-spacing:0.1em;">本会議発言</div></div>
  </div>
</div>
<div style="margin-top:10px; padding:0 20px; display:flex; border-bottom:1px solid {s['rule']};">
  <div style="flex:1; padding:12px 0 10px; text-align:center; font-size:14px; font-weight:700; color:{s['acc']}; border-bottom:2px solid {s['acc']};">すべて</div>
  <div style="flex:1; padding:12px 0 10px; text-align:center; font-size:14px; color:{s['muted']};">採決</div>
  <div style="flex:1; padding:12px 0 10px; text-align:center; font-size:14px; color:{s['muted']};">提出法案</div>
  <div style="flex:1; padding:12px 0 10px; text-align:center; font-size:14px; color:{s['muted']};">発言</div>
</div>'''
    def dh(d,l):
        if s['name']=='ポスター':
            return f'<div style="padding:20px 20px 2px; display:flex; align-items:center; gap:10px;"><div class="h num" style="font-size:16px; font-weight:900;">{d}</div><div style="font-size:12px; font-weight:700; color:{s["muted"]};">{l}</div></div>'
        if s['name']=='計器盤':
            return f'<div style="padding:18px 20px 2px; display:flex; align-items:center; gap:10px;"><div class="num" style="font-size:12px; font-weight:600; color:{s["acc"]};">{d}</div><div style="font-size:12px; color:{s["muted"]};">{l}</div></div>'
        return f'<div style="padding:18px 20px 0; display:flex; align-items:baseline; gap:10px;"><div class="h num" style="font-size:15px; font-weight:700; color:{s["acc2"]};">{d}</div><div style="font-size:12px; color:{s["muted"]};">{l}</div></div>'
    body=f'''
<div style="padding:10px 20px 0; display:flex; gap:8px; align-items:center;">
  <div style="flex:1; padding:9px 12px; border:1px solid {s['rule']}; font-size:13px; color:{s['muted']}; border-radius:{s['radius']};">記録を検索（法案名など）</div>
  <div style="padding:9px 12px; border:1px solid {s['rule']}; font-size:13px; border-radius:{s['radius']};">第221回 ▾</div>
</div>
{dh('2026.07.24','本会議')}
<div style="padding:0 20px; display:flex; flex-direction:column;">
{item(s,'yes','日本国憲法の改正手続に関する法律の一部を改正する法律案','衆議院提出 ・ 可決 <span class="num">148–94</span> ・ 会派は賛成 ・ <a href="#">参院投票結果</a>')}
{item(s,'yes','予防接種法の一部を改正する法律案','内閣提出 ・ 可決 ・ <a href="#">参院投票結果</a>')}
{item(s,'none','大都市地域における特別区の設置に関する法律の一部を改正する法律案','議員発議 ・ 否決 ・ 投票なし（理由は記録されない） ・ <a href="#">参院投票結果</a>')}
</div>
{dh('2026.06.05','本会議')}
<div style="padding:0 20px; display:flex; flex-direction:column;">
{item(s,'spk','令和八年度補正予算二案について、財政金融委員長として審査の経過と結果を報告','委員長報告 ・ <span class="num">1,840</span>字 ・ <a href="#">会議録</a>')}
{item(s,'yes','令和八年度一般会計補正予算（第１号）','可決 <span class="num">148–94</span> ・ <a href="#">参院投票結果</a>')}
</div>
{dh('2026.03.10','議案提出')}
<div style="padding:0 20px; display:flex; flex-direction:column;">
{item(s,'sub','［サンプル］○○法の一部を改正する法律案','参法 第221回 第3号 ・ 発議者（筆頭） ・ 審議未了 ・ <a href="#">参院議案情報</a>')}
</div>
<div style="padding:24px 20px; display:flex; flex-direction:column; gap:14px;">
  <div style="padding:12px; text-align:center; font-size:14px; border-radius:{s['radius']}; {s['btn']}">さらに古い記録（2025.12 —）</div>
  <div style="font-size:11px; color:{s['muted']}; line-height:1.7;">出典：参議院 本会議投票結果／参議院 議案情報／国会会議録検索システム。取得 <span class="num">2026.08.22 06:00</span>。このサイトは記録を並べるだけで、評価はしません。<a href="#">データについて</a></div>
</div>'''
    return f'{HEAD}\n{helmet(s)}\n<div style="width:390px; min-height:1560px; background:{s["bg"]}; display:flex; flex-direction:column;">\n{header}\n{body}\n</div>\n{TAIL}'

def home(s):
    n=s['name']
    dark = n in ('夜の台帳',)
    hero_bg = s['brand'] if n in ('台帳','大胆な色面','ポスター') else s['bg']
    hero_fg = s['brandfg'] if n in ('台帳','大胆な色面','ポスター') else s['fg']
    hero_muted = 'rgba(255,255,255,0.75)' if n in ('台帳','大胆な色面','ポスター') else s['muted']
    logo_color = s['acc'] if n in ('台帳','夜の台帳','ポスター') else hero_fg
    hw = s['hw']
    title_size = {'台帳':34,'大胆な色面':40,'夜の台帳':34,'ポスター':46,'計器盤':30}[n]
    search_style = {
      '台帳': f'border:1.5px solid {s["acc"]}; background:#fbfaf7; color:#8d877c;',
      '大胆な色面': 'background:#fff; color:#8a9391; font-weight:700;',
      '夜の台帳': f'border:1.5px solid {s["acc"]}; background:#24252a; color:{s["muted"]};',
      'ポスター': f'background:{s["bg"]}; color:{s["muted"]}; border-radius:999px;',
      '計器盤': f'background:#fff; border:1px solid {s["rule"]}; color:{s["muted"]}; border-radius:6px; box-shadow:0 1px 2px rgba(0,0,0,0.04);',
    }[n]
    chip = {
      '台帳': f'border:1px solid rgba(255,255,255,0.35); color:{hero_fg};',
      '大胆な色面': 'border:2px solid #fff; color:#fff; font-weight:700;',
      '夜の台帳': f'border:1px solid {s["rule"]}; color:{s["fg"]};',
      'ポスター': f'background:{s["acc"]}; color:{s["fg"]}; font-weight:700; border-radius:999px;',
      '計器盤': f'background:#fff; border:1px solid {s["rule"]}; border-radius:6px; color:{s["fg"]};',
    }[n]
    sec_color = s['acc2'] if n in ('台帳','夜の台帳','ポスター') else s['fg']
    def vote_row(title,meta):
        return f'''<div style="padding:11px 0; border-bottom:1px solid {s['rule']}; display:flex; flex-direction:column; gap:3px;">
      <div style="font-size:14px; line-height:1.45;">{title}</div>
      <div style="font-size:12px; color:{s['muted']};">{meta}</div>
    </div>'''
    card_bg = '#fff' if n=='計器盤' else ('#24252a' if dark else 'transparent')
    card_border = f'border:1px solid {s["rule"]}; border-radius:6px; padding:4px 14px;' if n=='計器盤' else (f'background:{card_bg}; padding:4px 14px; border:1px solid {s["rule"]};' if dark else '')
    return f'''{HEAD}
{helmet(s)}
<div style="width:390px; min-height:1300px; background:{s['bg']}; display:flex; flex-direction:column;">
  <div style="background:{hero_bg}; color:{hero_fg}; padding:22px 20px 26px; display:flex; flex-direction:column; gap:18px;">
    <div style="display:flex; justify-content:space-between; align-items:baseline;">
      <div class="h" style="font-size:18px; font-weight:{hw}; letter-spacing:0.12em; color:{logo_color};">政治記録</div>
      <a href="#" style="border:none; color:{hero_muted}; font-size:12px;">データについて</a>
    </div>
    <div style="display:flex; flex-direction:column; gap:10px;">
      <div class="h" style="font-size:{title_size}px; font-weight:{hw}; line-height:1.2; letter-spacing:0.02em;">言ったことではなく、<br>やったことを。</div>
      <div style="font-size:14px; line-height:1.75; color:{hero_muted};">国会議員が本会議でどう投票し、どの法案を出し、何を発言したか。公式記録だけを、そのまま並べます。評価はしません。</div>
    </div>
    <div style="padding:14px; font-size:16px; {search_style}">議員の名前で検索（例：ふじかわ）</div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; font-size:13px;">
      <div style="padding:7px 12px; {chip}">参議院の議員一覧</div>
      <div style="padding:7px 12px; {chip} opacity:0.55;">選挙区からさがす（準備中）</div>
    </div>
  </div>

  <div style="padding:22px 20px 0; display:flex; flex-direction:column; gap:6px;">
    <div style="display:flex; justify-content:space-between; align-items:baseline;">
      <div class="h" style="font-size:17px; font-weight:700; color:{sec_color};">最近の本会議採決</div>
      <div class="num" style="font-size:12px; color:{s['muted']};">第221回国会</div>
    </div>
    <div style="display:flex; flex-direction:column; {card_border}">
      {vote_row('日本国憲法の改正手続に関する法律の一部を改正する法律案','<span class="num">2026.07.24</span> ・ 可決 ・ <a href="#">誰がどう投票したか</a>')}
      {vote_row('国旗の損壊等の処罰に関する法律案','<span class="num">2026.07.17</span> ・ 可決 ・ <a href="#">誰がどう投票したか</a>')}
      {vote_row('ヒトゲノム編集胚等の取扱いの規制に関する法律案','<span class="num">2026.07.17</span> ・ 可決 ・ <a href="#">誰がどう投票したか</a>')}
      {vote_row('令和八年度一般会計補正予算（第１号）','<span class="num">2026.06.05</span> ・ 可決 <span class="num">148–94</span> ・ <a href="#">誰がどう投票したか</a>')}
    </div>
    <div style="padding:8px 0 0; font-size:13px;"><a href="#">第221回国会の採決 120件すべて</a></div>
  </div>

  <div style="padding:26px 20px 0; display:flex; flex-direction:column; gap:10px;">
    <div class="h" style="font-size:17px; font-weight:700; color:{sec_color};">このサイトにあるもの</div>
    <div style="display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:10px;">
      <div style="display:flex; flex-direction:column; gap:2px;"><div class="h num" style="font-size:26px; font-weight:700; line-height:1;">248</div><div style="font-size:11px; color:{s['muted']};">参議院議員</div></div>
      <div style="display:flex; flex-direction:column; gap:2px;"><div class="h num" style="font-size:26px; font-weight:700; line-height:1;">9,412</div><div style="font-size:11px; color:{s['muted']};">記名採決 1998—</div></div>
      <div style="display:flex; flex-direction:column; gap:2px;"><div class="h num" style="font-size:26px; font-weight:700; line-height:1;">80</div><div style="font-size:11px; color:{s['muted']};">国会（第142—221回）</div></div>
    </div>
    <div style="font-size:12px; color:{s['muted']}; line-height:1.7;">衆議院は個人の投票記録が公開されていないため、会派の態度として別に扱います（準備中）。</div>
  </div>

  <div style="padding:26px 20px 30px; display:flex; flex-direction:column; gap:8px;">
    <div class="h" style="font-size:17px; font-weight:700; color:{sec_color};">出典と更新</div>
    <div style="display:flex; flex-direction:column; font-size:13px;">
      <div class="num" style="display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid {s['rule']};"><span>参議院 本会議投票結果</span><span>2026.08.22 06:00</span></div>
      <div class="num" style="display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid {s['rule']};"><span>衆参 議案情報</span><span>2026.08.22 06:00</span></div>
      <div class="num" style="display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid {s['rule']};"><span>国会会議録検索システム</span><span>2026.08.22 06:00</span></div>
    </div>
    <div style="font-size:12px; display:flex; gap:16px; padding-top:6px;"><a href="#">ソースコード</a><a href="#">データ一括取得</a><a href="#">誤りを報告</a></div>
  </div>
</div>
{TAIL}'''

import io
for k,s in STYLES.items():
    open(f'Home{k}.dc.html','w',encoding='utf-8').write(home(s))
for k in ('C','D','E'):
    open(f'Member{k}.dc.html','w',encoding='utf-8').write(member_page(STYLES[k]))
print('generated')
