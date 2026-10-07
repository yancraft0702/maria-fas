import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../server/config.js';

const BASE = path.join(ROOT, 'animação');
const VISUAL_DIR = path.join(BASE, 'presentes');
const SOUND_DIR = path.join(BASE, 'sons');
const DURATION_MS = 3800;
const RATE = 22050;
const LEGACY = [
  'coracoes-subindo', 'chuva-de-estrelas', 'confete-festa', 'fogo-estilizado',
  'arco-de-luz', 'aura-rosa', 'flores-subindo', 'aplausos', 'presente',
  'energia', 'sparkle-onda', 'balao-festa', 'faisca-magica', 'coroa-festa',
  'notas-musica', 'trovao-luz', 'vitoria-fanfarra', 'magia-varinha',
  'surpresa-salto', 'cinema-impacto', 'carnaval-mascara', 'dj-bumbo',
  'guitarra-rock', 'neve-branca', 'pipoca-estourando', 'fogos-artificio',
  'onda-praia', 'piano-lua', 'bolhas-sereia', 'sol-nascente',
];

const gifts = [
  {
    slug: 'rosa-premium', name: 'Rosa premium', emoji: '🌹', color: '#f04f86',
    art: `<path d="M240 435C232 368 250 320 240 258" fill="none" stroke="url(#leaf)" stroke-width="13" stroke-linecap="round"/>
      <path d="M239 354C195 318 169 324 160 336C184 367 212 374 241 367M243 388C284 348 312 350 324 360C303 391 272 402 242 399" fill="url(#leaf)" stroke="#b5e4a5" stroke-width="3"/>
      <path d="M239 292C191 281 171 246 192 213C205 193 230 193 244 213C254 183 286 175 307 197C338 229 306 276 245 303Z" fill="url(#rose)" stroke="#ffd3dc" stroke-width="4"/>
      <path d="M239 286C211 268 208 242 224 226C238 211 259 217 263 235C274 219 294 226 292 244C290 262 271 279 244 295Z" fill="#fa8eaa" stroke="#ffe0e5" stroke-width="3"/>
      <path d="M225 224C214 211 221 197 235 193M267 231C286 214 300 217 306 229" fill="none" stroke="#fff0f2" stroke-width="5" stroke-linecap="round"/>
      <path d="M153 438Q240 407 327 438" fill="none" stroke="#ffd88a" stroke-width="3" opacity=".75"/>`,
    sound: [
      ['sweep', 0.04, 1.5, 850, 1850, 0.24, 'sine'],
      ['tone', 0.48, 0.44, 1568, 0.25, 'sine'],
      ['tone', 0.77, 0.54, 2093, 0.18, 'sine'],
      ['tone', 1.1, 0.65, 2637, 0.13, 'sine'],
      ['noise', 0.34, 2.2, 0.09, 0.8],
    ],
  },
  {
    slug: 'coracao-cristal', name: 'Coração de cristal', emoji: '💎', color: '#a877ff',
    art: `<path d="M240 438C201 402 135 344 135 276C135 226 174 199 215 220C228 227 237 240 240 250C247 226 268 211 293 213C338 217 361 254 350 295C336 348 283 400 240 438Z" fill="url(#crystal)" stroke="#f1eaff" stroke-width="5"/>
      <path d="M240 250L191 238L157 270L240 438M240 250L286 230L337 263L240 438M157 270L222 292L240 438M337 263L274 294L240 438M191 238L222 292L286 230L274 294" fill="none" stroke="#fff" stroke-opacity=".65" stroke-width="4"/>
      <path d="M179 271L211 249L222 292L178 300ZM286 230L325 258L274 294Z" fill="#fff" opacity=".38"/>
      <path d="M224 230Q237 214 251 231" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>`,
    sound: [
      ['tone', 0.08, 0.2, 82, 0.5, 'sine'], ['tone', 0.52, 0.24, 82, 0.45, 'sine'],
      ['sweep', 0.62, 1.2, 880, 2093, 0.22, 'sine'],
      ['tone', 0.85, 1.4, 1568, 0.19, 'sine'], ['tone', 1.0, 1.6, 2349, 0.1, 'sine'],
    ],
  },
  {
    slug: 'urso-de-pelucia', name: 'Urso de pelúcia', emoji: '🧸', color: '#d09a62',
    art: `<ellipse cx="240" cy="365" rx="91" ry="105" fill="url(#plush)" stroke="#f8dfbc" stroke-width="5"/>
      <circle cx="177" cy="264" r="44" fill="url(#plush)" stroke="#f8dfbc" stroke-width="5"/><circle cx="303" cy="264" r="44" fill="url(#plush)" stroke="#f8dfbc" stroke-width="5"/>
      <circle cx="177" cy="264" r="21" fill="#f4c89e"/><circle cx="303" cy="264" r="21" fill="#f4c89e"/>
      <ellipse cx="240" cy="301" rx="81" ry="73" fill="url(#plush)" stroke="#f8dfbc" stroke-width="5"/>
      <ellipse cx="240" cy="324" rx="42" ry="30" fill="#f7dfc3"/><ellipse cx="240" cy="314" rx="13" ry="9" fill="#553a34"/>
      <circle cx="211" cy="293" r="7" fill="#382d2a"/><circle cx="269" cy="293" r="7" fill="#382d2a"/>
      <path d="M225 339Q240 352 255 339" fill="none" stroke="#7d5140" stroke-width="4" stroke-linecap="round"/>
      <ellipse cx="155" cy="375" rx="29" ry="52" transform="rotate(-35 155 375)" fill="#b87b4c" stroke="#f8dfbc" stroke-width="4"/>
      <ellipse cx="325" cy="375" rx="29" ry="52" transform="rotate(35 325 375)" fill="#b87b4c" stroke="#f8dfbc" stroke-width="4"/>
      <path d="M209 384Q240 360 271 384L261 412H219Z" fill="url(#rose)"/><circle cx="240" cy="391" r="10" fill="url(#gold)"/>`,
    sound: [
      ['noise', 0.04, 0.12, 0.32, 0.28], ['tone', 0.12, 0.55, 392, 0.38, 'sine'],
      ['tone', 0.34, 0.82, 587, 0.22, 'sine'], ['tone', 0.57, 0.95, 784, 0.14, 'sine'],
      ['sweep', 0.08, 0.34, 190, 480, 0.18, 'sine'],
    ],
  },
  {
    slug: 'borboletas-douradas', name: 'Borboletas douradas', emoji: '🦋', color: '#f3ba4c',
    art: `<g fill="url(#gold)" stroke="#fff1b8" stroke-width="3">
      <path d="M232 315C194 247 139 231 138 274C137 304 178 327 232 334C186 345 168 386 195 400C219 412 237 376 240 341Z"/>
      <path d="M248 315C286 247 341 231 342 274C343 304 302 327 248 334C294 345 312 386 285 400C261 412 243 376 240 341Z"/>
      <path d="M154 243C140 213 162 203 184 229M326 243C340 213 318 203 296 229" fill="none" stroke-linecap="round"/>
      </g><ellipse cx="240" cy="338" rx="7" ry="43" fill="#fff3c8"/>
      <g fill="#fff8df" opacity=".85"><circle cx="170" cy="280" r="7"/><circle cx="196" cy="305" r="5"/><circle cx="310" cy="281" r="7"/><circle cx="284" cy="305" r="5"/></g>
      <path d="M240 340C195 380 171 414 135 424M240 340C285 380 309 414 345 424" fill="none" stroke="#e7b64e" stroke-width="3" stroke-dasharray="6 10"/>`,
    sound: [
      ['noise', 0.1, 2.0, 0.16, 0.72], ['sweep', 0.05, 1.0, 420, 1500, 0.16, 'sine'],
      ['sweep', 0.82, 0.9, 1500, 760, 0.14, 'sine'],
      ['tone', 0.35, 0.28, 1760, 0.15, 'sine'], ['tone', 1.05, 0.42, 2217, 0.16, 'sine'],
      ['tone', 1.55, 0.48, 2637, 0.12, 'sine'],
    ],
  },
  {
    slug: 'aguia-majestosa', name: 'Águia majestosa', emoji: '🦅', color: '#b98548',
    art: `<path d="M238 329C195 294 151 247 104 231C122 272 137 311 177 337C143 331 120 337 91 356C134 382 180 388 222 367L240 348L258 367C300 388 346 382 389 356C360 337 337 331 303 337C343 311 358 272 376 231C329 247 285 294 242 329Z" fill="url(#gold)" stroke="#fff0c0" stroke-width="5" stroke-linejoin="round"/>
      <path d="M240 281C219 312 208 350 217 384L240 415L263 384C272 350 261 312 240 281Z" fill="url(#plush)" stroke="#fff0c0" stroke-width="4"/>
      <path d="M215 327L168 292M210 347L150 325M266 327L312 292M270 347L330 325" fill="none" stroke="#fff5dd" stroke-width="6" stroke-linecap="round"/>
      <path d="M227 315L240 298L253 315L240 329Z" fill="#fff5d8"/><path d="M240 328L257 343L240 354L223 343Z" fill="#f0a735"/>
      <path d="M240 383L226 421L240 410L254 421Z" fill="#d98e32"/>`,
    sound: [
      ['noise', 0.02, 1.55, 0.34, 0.16], ['sweep', 0.02, 1.75, 190, 70, 0.2, 'sine'],
      ['sweep', 0.44, 0.9, 490, 880, 0.22, 'sine'], ['sweep', 1.38, 0.75, 880, 350, 0.2, 'sine'],
      ['tone', 0.62, 0.54, 660, 0.12, 'triangle'],
    ],
  },
  {
    slug: 'lobo-uivando', name: 'Lobo uivando', emoji: '🐺', color: '#97a1b6',
    art: `<path d="M160 291L145 209L211 246Q240 232 269 246L335 209L320 291Q344 329 323 374Q302 421 240 437Q178 421 157 374Q136 329 160 291Z" fill="url(#silver)" stroke="#eaf0ff" stroke-width="5" stroke-linejoin="round"/>
      <path d="M169 273L162 230L198 258M311 273L318 230L282 258" fill="#3e4b64" stroke="#eaf0ff" stroke-width="4"/>
      <path d="M180 317Q202 293 225 318M255 318Q278 293 300 317" fill="none" stroke="#172236" stroke-width="9" stroke-linecap="round"/>
      <path d="M215 352Q240 334 265 352Q266 382 240 394Q214 382 215 352Z" fill="#ecf1f8" stroke="#c7d1e2" stroke-width="3"/>
      <path d="M231 351L240 344L249 351L240 361Z" fill="#253047"/>
      <path d="M228 403Q240 414 252 403" fill="none" stroke="#516078" stroke-width="4"/>
      <path d="M104 302Q80 278 96 251M376 302Q400 278 384 251" fill="none" stroke="#b7c9e8" stroke-width="5" stroke-linecap="round" opacity=".8"/>`,
    sound: [
      ['sweep', 0.1, 2.1, 105, 540, 0.42, 'sine'], ['sweep', 0.1, 2.0, 210, 1080, 0.17, 'sine'],
      ['noise', 0.02, 1.15, 0.22, 0.12], ['sweep', 1.92, 0.72, 530, 250, 0.2, 'sine'],
    ],
  },
  {
    slug: 'leao-dourado', name: 'Leão dourado', emoji: '🦁', color: '#e9a833',
    art: `<g fill="url(#gold)" stroke="#fff0bf" stroke-width="4">
      <path d="M240 218L270 247L309 228L318 268L358 280L341 317L372 348L338 374L345 414L302 414L281 450L240 428L199 450L178 414L135 414L142 374L108 348L139 317L122 280L162 268L171 228L210 247Z"/>
      </g><circle cx="240" cy="337" r="92" fill="url(#plush)" stroke="#fff0bf" stroke-width="5"/>
      <path d="M188 315Q207 290 226 316M254 316Q273 290 292 315" fill="none" stroke="#563919" stroke-width="9" stroke-linecap="round"/>
      <ellipse cx="240" cy="355" rx="50" ry="39" fill="#f4d7a8"/>
      <path d="M226 342L240 332L254 342L240 355Z" fill="#573725"/>
      <path d="M239 355Q226 375 208 367M241 355Q254 375 272 367" fill="none" stroke="#75502f" stroke-width="4"/>
      <path d="M178 345L144 336M179 360L141 364M302 345L336 336M301 360L339 364" stroke="#fff3dc" stroke-width="3" stroke-linecap="round"/>`,
    sound: [
      ['sweep', 0.05, 1.8, 95, 42, 0.46, 'saw'], ['noise', 0.08, 1.6, 0.36, 0.1],
      ['sweep', 0.13, 1.5, 190, 83, 0.27, 'saw'], ['tone', 0.05, 0.32, 58, 0.32, 'sine'],
      ['noise', 1.35, 1.25, 0.13, 0.08],
    ],
  },
  {
    slug: 'fogos-de-artificio', name: 'Fogos de artifício', emoji: '🎆', color: '#ed88ff',
    art: `<g fill="none" stroke-linecap="round">
      <circle cx="240" cy="334" r="12" fill="#fff9dc" stroke="none"/>
      <g stroke="url(#rose)" stroke-width="8">${Array.from({ length: 12 }, (_, i) => `<path d="M240 334L240 ${205 + (i % 3) * 8}" transform="rotate(${i * 30} 240 334)"/>`).join('')}</g>
      <g stroke="url(#gold)" stroke-width="5">${Array.from({ length: 10 }, (_, i) => `<path d="M240 334L240 242" transform="rotate(${18 + i * 36} 240 334)"/>`).join('')}</g>
      <g stroke="#c2b5ff" stroke-width="4">${Array.from({ length: 8 }, (_, i) => `<path d="M240 334L240 270" transform="rotate(${i * 45 + 18} 240 334)"/>`).join('')}</g>
      </g><circle cx="240" cy="334" r="68" fill="none" stroke="#fff" stroke-opacity=".52" stroke-width="3"/>
      <path d="M118 400Q174 364 240 400Q306 364 362 400" fill="none" stroke="#ffeab3" stroke-width="4" opacity=".7"/>`,
    sound: [
      ['noise', 0.06, 0.5, 0.22, 0.14], ['sweep', 0.04, 0.65, 120, 980, 0.18, 'sine'],
      ['noise', 0.7, 0.55, 0.65, 0.76], ['tone', 0.72, 1.1, 1760, 0.23, 'sine'],
      ['noise', 1.46, 0.42, 0.43, 0.8], ['tone', 1.42, 1.0, 2217, 0.18, 'sine'],
      ['tone', 1.82, 0.8, 2637, 0.12, 'sine'],
    ],
  },
  {
    slug: 'coroa-real', name: 'Coroa real', emoji: '👑', color: '#e6b540',
    art: `<path d="M142 377L118 259L187 303L239 224L294 303L362 259L338 377Z" fill="url(#gold)" stroke="#fff3c2" stroke-width="6" stroke-linejoin="round"/>
      <path d="M143 380L337 380L329 412L151 412Z" fill="#c78a22" stroke="#fff3c2" stroke-width="5"/>
      <path d="M160 369L185 314L220 369ZM260 369L294 314L320 369Z" fill="#ffdf83" opacity=".65"/>
      <path d="M211 369L240 290L269 369Z" fill="#fff4d0" opacity=".6"/>
      <circle cx="118" cy="253" r="11" fill="#fff4cf"/><circle cx="239" cy="217" r="13" fill="#fff4cf"/><circle cx="362" cy="253" r="11" fill="#fff4cf"/>
      <path d="M183 396H297" stroke="#fff6d9" stroke-width="4" stroke-linecap="round"/>
      <path d="M108 440Q240 420 372 440" fill="none" stroke="#d6ae5b" stroke-width="3"/>`,
    sound: [
      ['tone', 0.08, 1.7, 784, 0.27, 'sine'], ['tone', 0.34, 1.5, 1175, 0.2, 'sine'],
      ['tone', 0.62, 1.8, 1568, 0.2, 'sine'], ['tone', 1.0, 1.9, 2093, 0.14, 'sine'],
      ['noise', 0.3, 2.4, 0.055, 0.8],
    ],
  },
  {
    slug: 'notas-musicais', name: 'Notas musicais', emoji: '🎼', color: '#7c9cff',
    art: `<path d="M117 312Q180 273 239 312T363 312M117 345Q180 306 239 345T363 345M117 378Q180 339 239 378T363 378" fill="none" stroke="#a5bcff" stroke-width="5" stroke-linecap="round"/>
      <g fill="url(#crystal)" stroke="#eef1ff" stroke-width="4">
      <path d="M170 301V220L222 204V285Q219 307 195 311Q169 316 170 301Z"/>
      <path d="M260 348V246L312 230V328Q309 350 285 355Q259 360 260 348Z"/>
      </g><path d="M222 204L312 230" stroke="#fff" stroke-width="5"/>
      <circle cx="193" cy="304" r="8" fill="#fff"/><circle cx="283" cy="348" r="8" fill="#fff"/>
      <path d="M136 242C113 274 113 300 128 324M344 242C367 274 367 300 352 324" fill="none" stroke="#ffd782" stroke-width="4" stroke-linecap="round"/>`,
    sound: [
      ['tone', 0.05, 0.48, 523, 0.32, 'sine'], ['tone', 0.48, 0.48, 659, 0.3, 'sine'],
      ['tone', 0.92, 0.5, 784, 0.29, 'sine'], ['tone', 1.4, 0.56, 1047, 0.25, 'sine'],
      ['tone', 1.95, 0.66, 1319, 0.18, 'sine'], ['tone', 2.6, 0.85, 1568, 0.14, 'sine'],
    ],
  },
  {
    slug: 'disco-boom', name: 'Disco boom', emoji: '💿', color: '#72d5e9',
    art: `<circle cx="240" cy="340" r="125" fill="url(#crystal)" stroke="#f1ffff" stroke-width="5"/>
      <circle cx="240" cy="340" r="100" fill="none" stroke="#fff" stroke-opacity=".64" stroke-width="3"/>
      <circle cx="240" cy="340" r="75" fill="none" stroke="#d3fbff" stroke-opacity=".7" stroke-width="4"/>
      <circle cx="240" cy="340" r="48" fill="url(#gold)" stroke="#fff" stroke-width="4"/>
      <circle cx="240" cy="340" r="13" fill="#222a54" stroke="#fff" stroke-width="4"/>
      <path d="M240 340L326 254M151 393L194 367M278 448L294 401" stroke="#fff" stroke-opacity=".72" stroke-width="6" stroke-linecap="round"/>
      <path d="M114 280Q86 340 114 400M366 280Q394 340 366 400" fill="none" stroke="#a8f5ff" stroke-width="6" stroke-linecap="round"/>
      <path d="M92 256Q52 340 92 424M388 256Q428 340 388 424" fill="none" stroke="#d4b4ff" stroke-width="4" stroke-linecap="round" opacity=".7"/>`,
    sound: [
      ['tone', 0.02, 0.22, 58, 0.48, 'sine'], ['noise', 0.02, 0.15, 0.38, 0.2],
      ['tone', 0.5, 0.2, 65, 0.42, 'sine'], ['noise', 0.5, 0.12, 0.32, 0.2],
      ['tone', 1.0, 0.22, 58, 0.48, 'sine'], ['noise', 1.0, 0.15, 0.38, 0.2],
      ['tone', 1.5, 0.2, 65, 0.42, 'sine'], ['noise', 1.5, 0.12, 0.32, 0.2],
      ['tone', 0.12, 1.5, 110, 0.18, 'saw'],
      ['noise', 0.25, 0.06, 0.15, 0.85], ['noise', 0.75, 0.06, 0.15, 0.85],
      ['noise', 1.25, 0.06, 0.15, 0.85], ['noise', 1.75, 0.06, 0.15, 0.85],
    ],
  },
  {
    slug: 'presente-dourado', name: 'Presente dourado', emoji: '🎁', color: '#e9b447',
    art: `<path d="M155 309H325V432H155Z" fill="url(#rose)" stroke="#fff0c4" stroke-width="6"/>
      <path d="M141 279H339V325H141Z" fill="url(#gold)" stroke="#fff5d5" stroke-width="6"/>
      <path d="M226 280H254V432H226Z" fill="#fff4c9"/><path d="M141 325H339" stroke="#fff4c9" stroke-width="7"/>
      <path d="M240 280C178 272 175 221 204 220C231 219 240 252 240 280ZM240 280C302 272 305 221 276 220C249 219 240 252 240 280Z" fill="url(#gold)" stroke="#fff5d5" stroke-width="5"/>
      <path d="M190 350L208 365L190 380M290 350L272 365L290 380" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M170 452Q240 433 310 452" fill="none" stroke="#f5ce76" stroke-width="4"/>`,
    sound: [
      ['noise', 0.05, 0.17, 0.35, 0.2], ['tone', 0.12, 0.25, 196, 0.24, 'sine'],
      ['sweep', 0.34, 0.52, 180, 1300, 0.18, 'sine'],
      ['tone', 0.82, 1.3, 1568, 0.2, 'sine'], ['tone', 1.0, 1.6, 2093, 0.15, 'sine'],
      ['noise', 0.78, 1.35, 0.09, 0.78], ['tone', 1.45, 0.85, 2637, 0.11, 'sine'],
    ],
  },
  {
    slug: 'portal-de-luz', name: 'Portal de luz', emoji: '🌀', color: '#75c7ff',
    art: `<ellipse cx="240" cy="344" rx="111" ry="149" fill="none" stroke="url(#crystal)" stroke-width="18"/>
      <ellipse cx="240" cy="344" rx="83" ry="121" fill="none" stroke="#f6fdff" stroke-opacity=".82" stroke-width="5" stroke-dasharray="20 12"/>
      <ellipse cx="240" cy="344" rx="60" ry="95" fill="url(#portal)" opacity=".82"/>
      <ellipse cx="240" cy="344" rx="41" ry="71" fill="none" stroke="#fff" stroke-opacity=".72" stroke-width="4"/>
      <path d="M161 260C193 211 284 203 322 254M320 430C284 481 190 481 157 429" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
      <path d="M104 341L137 329M343 357L377 345M179 484L192 455M288 233L301 203" stroke="#d5f4ff" stroke-width="5" stroke-linecap="round"/>`,
    sound: [
      ['sweep', 0.02, 2.7, 80, 920, 0.32, 'sine'], ['noise', 0.03, 1.45, 0.24, 0.13],
      ['sweep', 0.22, 2.2, 260, 1780, 0.16, 'sine'], ['tone', 0.85, 1.75, 1760, 0.13, 'sine'],
      ['sweep', 2.55, 0.75, 950, 190, 0.16, 'sine'],
    ],
  },
  {
    slug: 'chuva-de-estrelas-premium', name: 'Chuva de estrelas', emoji: '🌠', color: '#b5a9ff',
    art: `<g fill="none" stroke-linecap="round">
      <path d="M113 263L188 321M179 216L239 292M277 207L250 299M366 255L294 323M133 367L199 354M348 382L280 361" stroke="url(#crystal)" stroke-width="13"/>
      </g>
      <g fill="url(#gold)" stroke="#fff9df" stroke-width="4">
      <path d="M188 302L201 330L232 334L209 354L215 385L188 370L161 385L167 354L144 334L175 330Z"/>
      <path d="M281 296L290 316L312 319L296 333L300 355L281 344L262 355L266 333L250 319L272 316Z"/>
      <path d="M241 228L250 246L270 249L255 263L259 283L241 274L223 283L227 263L212 249L232 246Z"/>
      </g><circle cx="130" cy="423" r="6" fill="#fff"/><circle cx="354" cy="222" r="7" fill="#fff"/><circle cx="333" cy="437" r="5" fill="#fff"/>`,
    sound: [
      ['tone', 0.12, 0.62, 1760, 0.25, 'sine'], ['tone', 0.55, 0.74, 2093, 0.21, 'sine'],
      ['tone', 0.98, 0.68, 2637, 0.18, 'sine'], ['tone', 1.38, 0.83, 3136, 0.14, 'sine'],
      ['tone', 1.86, 0.9, 3520, 0.1, 'sine'], ['noise', 0.16, 2.2, 0.06, 0.9],
    ],
  },
  {
    slug: 'coracao-confetes', name: 'Coração + confetes', emoji: '💝', color: '#f26398',
    art: `<g fill="url(#rose)" stroke="#ffe6ef" stroke-width="4">
      <path d="M240 418C207 389 158 349 158 301C158 265 185 244 215 257C228 263 237 275 240 285C246 265 265 252 286 254C324 257 342 286 333 316C321 354 276 394 240 418Z"/>
      </g><path d="M240 281C226 261 211 260 198 271C184 283 190 306 211 326" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
      <g fill="url(#gold)" stroke="#fff5d8" stroke-width="2">
      <path d="M128 254L137 273L158 276L143 291L147 312L128 302L109 312L113 291L98 276L119 273Z"/>
      <path d="M351 236L358 251L375 254L363 266L366 283L351 275L336 283L339 266L327 254L344 251Z"/>
      <path d="M124 377L131 392L148 394L136 406L139 423L124 415L109 423L112 406L100 394L117 392Z"/>
      </g><path d="M167 218L180 237M311 222L298 242M355 348L374 335M97 327L111 338M188 448L199 433M291 448L280 433" stroke="#ffd7e4" stroke-width="9" stroke-linecap="round"/>
      <circle cx="240" cy="340" r="136" fill="none" stroke="#ffd88c" stroke-opacity=".35" stroke-width="3"/>`,
    sound: [
      ['tone', 0.05, 0.16, 72, 0.47, 'sine'], ['tone', 0.42, 0.19, 72, 0.42, 'sine'],
      ['noise', 0.8, 0.42, 0.32, 0.78],
      ['tone', 0.82, 0.46, 784, 0.2, 'sine'], ['tone', 1.02, 0.6, 1047, 0.18, 'sine'],
      ['tone', 1.28, 0.82, 1319, 0.14, 'sine'],
    ],
  },
];

const defs = `<defs>
  <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff8d7"/><stop offset=".22" stop-color="#f6d77e"/><stop offset=".52" stop-color="#cc8b28"/><stop offset=".78" stop-color="#ffe5a0"/><stop offset="1" stop-color="#a76119"/></linearGradient>
  <linearGradient id="rose" x1=".15" y1="0" x2=".85" y2="1"><stop stop-color="#ffe3e8"/><stop offset=".22" stop-color="#ff9caf"/><stop offset=".55" stop-color="#ed527f"/><stop offset=".82" stop-color="#ad285a"/><stop offset="1" stop-color="#74184c"/></linearGradient>
  <linearGradient id="leaf" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#d8f5b0"/><stop offset=".48" stop-color="#72ae69"/><stop offset="1" stop-color="#2b7358"/></linearGradient>
  <linearGradient id="crystal" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff"/><stop offset=".19" stop-color="#bcecff"/><stop offset=".45" stop-color="#80a5ff"/><stop offset=".7" stop-color="#b48bff"/><stop offset="1" stop-color="#f7d2ff"/></linearGradient>
  <linearGradient id="silver" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f6f8ff"/><stop offset=".4" stop-color="#a9b6ca"/><stop offset=".72" stop-color="#64728c"/><stop offset="1" stop-color="#313e56"/></linearGradient>
  <radialGradient id="plush" cx=".34" cy=".22" r=".85"><stop stop-color="#ffedcf"/><stop offset=".35" stop-color="#dbab78"/><stop offset=".75" stop-color="#a86e48"/><stop offset="1" stop-color="#68433c"/></radialGradient>
  <radialGradient id="portal"><stop stop-color="#fff" stop-opacity=".92"/><stop offset=".3" stop-color="#b8edff" stop-opacity=".7"/><stop offset=".72" stop-color="#9b83ff" stop-opacity=".32"/><stop offset="1" stop-color="#c8a2ff" stop-opacity="0"/></radialGradient>
  <filter id="softGlow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="7" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>`;

function svgFor(gift) {
  const sparkles = [[105, 295], [367, 289], [128, 438], [350, 450], [182, 190], [300, 186]]
    .map(([x, y], i) => `<path d="M${x} ${y - 11}L${x + 3} ${y - 3}L${x + 11} ${y}L${x + 3} ${y + 3}L${x} ${y + 11}L${x - 3} ${y + 3}L${x - 11} ${y}L${x - 3} ${y - 3}Z" fill="${i % 2 ? '#fff6d7' : gift.color}" opacity=".85"><animate attributeName="opacity" values=".25;1;.35" dur="${1.2 + i * 0.13}s" repeatCount="indefinite"/></path>`)
    .join('');
  const particles = [[112, 340, -30, -72], [368, 340, 32, -82], [148, 455, -44, -32], [331, 462, 42, -38], [178, 205, -32, 48], [306, 201, 34, 48]]
    .map(([x, y, dx, dy], i) => `<circle cx="${x}" cy="${y}" r="${i % 2 ? 5 : 7}" fill="${i % 2 ? '#fff' : gift.color}" opacity="0"><animate attributeName="opacity" values="0;1;0" keyTimes="0;.25;1" dur="3.8s" repeatCount="indefinite"/><animateTransform attributeName="transform" type="translate" values="0 0;${dx} ${dy}" dur="3.8s" repeatCount="indefinite"/></circle>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="768" viewBox="0 0 480 768">
    ${defs}
    <ellipse cx="240" cy="372" rx="154" ry="160" fill="${gift.color}" opacity=".13" filter="url(#softGlow)"/>
    <g fill="none" stroke="${gift.color}" stroke-width="4" opacity=".54">
      <ellipse cx="240" cy="368" rx="150" ry="176" stroke-dasharray="8 20" transform="rotate(-18 240 368)"><animateTransform attributeName="transform" type="rotate" from="-18 240 368" to="342 240 368" dur="14s" repeatCount="indefinite"/></ellipse>
    </g>
    <ellipse cx="240" cy="372" rx="120" ry="120" fill="none" stroke="#fff" stroke-width="3" opacity="0">
      <animate attributeName="opacity" values="0;.72;0" keyTimes="0;.42;1" dur="3.8s" repeatCount="indefinite"/>
      <animate attributeName="rx" values="28;168" dur="3.8s" repeatCount="indefinite"/>
      <animate attributeName="ry" values="28;198" dur="3.8s" repeatCount="indefinite"/>
    </ellipse>
    <g>${sparkles}${particles}</g>
    <g>
      <animateTransform attributeName="transform" type="translate" values="0 58;0 -8;0 0;0 0;0 -34" keyTimes="0;.18;.3;.78;1" dur="3.8s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0;1;1;1;0" keyTimes="0;.12;.3;.78;1" dur="3.8s" repeatCount="indefinite"/>
      <animateTransform attributeName="transform" additive="sum" type="scale" values=".72;.98;1.035;1;1" keyTimes="0;.18;.34;.46;1" dur="3.8s" repeatCount="indefinite"/>
      <g filter="url(#softGlow)">${gift.art}</g>
      <path d="M145 476Q240 507 335 476" fill="none" stroke="#fff" stroke-opacity=".48" stroke-width="3" stroke-linecap="round"/>
    </g>
  </svg>`;
}

const TAU = Math.PI * 2;
function makeWav(events, seed) {
  const frames = Math.ceil(RATE * DURATION_MS / 1000);
  const samples = new Float32Array(frames);
  let rng = seed >>> 0;
  const random = () => {
    rng = (rng * 1664525 + 1013904223) >>> 0;
    return (rng / 0x80000000) - 1;
  };
  const eventFrames = events.map((e) => ({ e, from: Math.floor(e[1] * RATE), to: Math.min(frames, Math.floor((e[1] + e[2]) * RATE)) }));
  for (let i = 0; i < frames; i += 1) {
    let value = 0;
    for (const { e, from, to } of eventFrames) {
      if (i < from || i >= to) continue;
      const [kind, start, duration, a, b, c, wave = 'sine'] = e;
      const t = (i - from) / RATE;
      const p = t / duration;
      const envelope = Math.sin(Math.PI * Math.min(1, p)) ** (kind === 'noise' ? 1.5 : 0.8);
      if (kind === 'tone') {
        const phase = TAU * a * t;
        value += (wave === 'triangle' ? 2 / Math.PI * Math.asin(Math.sin(phase)) : Math.sin(phase)) * b * envelope;
      } else if (kind === 'sweep') {
        const freq = a * ((b / a) ** p);
        const phase = TAU * ((a * t) + (freq - a) * t / 2);
        value += (wave === 'saw' ? 2 * ((phase / TAU) % 1) - 1 : Math.sin(phase)) * c * envelope;
      } else {
        const cutoff = Math.max(0.015, Math.min(0.95, b));
        makeWav.noiseState += cutoff * (random() - makeWav.noiseState);
        value += makeWav.noiseState * a * envelope;
      }
    }
    const fadeOut = Math.min(1, (frames - i) / (RATE * 0.24));
    samples[i] = value * fadeOut;
  }
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  const gain = peak ? 0.72 / peak : 1;
  const pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] * gain)) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8); header.write('fmt ', 12); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
makeWav.noiseState = 0;

await fs.mkdir(VISUAL_DIR, { recursive: true });
await fs.mkdir(SOUND_DIR, { recursive: true });
for (const slug of LEGACY) {
  await fs.rm(path.join(BASE, `${slug}.png`), { force: true });
  await fs.rm(path.join(SOUND_DIR, `${slug}.wav`), { force: true });
}
for (const gift of gifts) {
  await fs.writeFile(path.join(VISUAL_DIR, `${gift.slug}.svg`), svgFor(gift), 'utf8');
  const seed = [...gift.slug].reduce((sum, char) => sum + char.charCodeAt(0), 0) + 701;
  makeWav.noiseState = 0;
  await fs.writeFile(path.join(SOUND_DIR, `${gift.slug}.wav`), makeWav(gift.sound, seed));
}
console.log(`Generated ${gifts.length} transparent animated SVG gifts and ${gifts.length} unique 3.8s WAV sounds.`);
