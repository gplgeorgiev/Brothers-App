import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { image_base64 } = await req.json();
    const apiKey = Deno.env.get("GOOGLE_VISION_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            image: { content: image_base64 },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            imageContext: { languageHints: ["bg", "en"] }
          }]
        })
      }
    );

    const data = await response.json();
    const fullText = data.responses?.[0]?.fullTextAnnotation?.text ?? "";
    const parsed = parseInvoice(fullText);

    return new Response(
      JSON.stringify({ raw_text: fullText, parsed }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

function parseInvoice(text: string) {
  const result: any = {
    contractor: null,
    document_ref: null,
    amount: null,
    amount_no_vat: null,
    date: null
  };

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // 1. Номер на фактура — толерантен към OCR грешки:
  //    ФАКТУРА, ВАКТУРА, ФAKTУPA, ФАКТУРА No, ФАКТУРА Н: ...
  //    Дори ако "Ф" е разпозната като "В" или "В" е "Б"
  const invoiceRegexes = [
    // Фактура с/без интервал, с N/№/No
    /(?:фактура|вактура|invoice)\s*[NН№]?[oОoо°]?[:.]?\s*(\d{6,15})/i,
    // "Номер: 0000000025" / "Номер на фактура: ..." (не "Номер на договор")
    /номер(?:\s*на\s*фактура)?\s*[:.]?\s*(\d{4,15})(?![\d.,])/i,
  ];
  for (const re of invoiceRegexes) {
    const m = text.match(re);
    if (m) { result.document_ref = 'Фактура ' + m[1]; break; }
  }

  // Номерата на фирмите (ДДС №, Идент. №, ЕИК, ЕГН) не са номер на документа
  const companyIdLine = /ддс|идент|еик|егн|булстат|тел/i;

  // По ЗДДС номерът на фактурата е точно 10 цифри (често с водещи нули).
  // Пропускаме телефони (0 + ненулева цифра, напр. 0889...) и цифри в IBAN.
  if (!result.document_ref) {
    for (const line of lines) {
      if (companyIdLine.test(line)) continue;
      const m = line.match(/(?<![\dA-Za-zА-Яа-я])(\d{10})(?!\d)/);
      if (m && !/^0[1-9]/.test(m[1])) { result.document_ref = 'Фактура ' + m[1]; break; }
    }
  }

  // № с цифри на същия или на следващия ред — но не след ДДС/Идент./ЕИК
  if (!result.document_ref) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('№') || companyIdLine.test(line)) continue;
      let m = line.match(/№[ \t]*:?[ \t]*(\d{6,15})/);
      if (!m && /№[ \t]*:?$/.test(line) && i + 1 < lines.length) m = lines[i + 1].match(/^(\d{6,15})$/);
      if (m) { result.document_ref = 'Фактура ' + m[1]; break; }
    }
  }

  // No: или N: самостоятелно (на отделен ред)
  if (!result.document_ref) {
    const m = text.match(/\b[NН]o?[°]?\s*:\s*(\d{6,15})/i);
    if (m) result.document_ref = 'Фактура ' + m[1];
  }

  // 2. Дата след ключова дума
  const dateContext = /(?:дата|date|изд\.|на\s+ДС|АС)[^\d]{0,30}(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{2,4})/i;
  const dateMatch = text.match(dateContext);
  if (dateMatch) {
    const day = dateMatch[1].padStart(2, '0');
    const month = dateMatch[2].padStart(2, '0');
    let year = dateMatch[3];
    if (year.length === 2) year = '20' + year;
    result.date = `${year}-${month}-${day}`;
  } else {
    // Fallback: търси дата с 4-цифрена година
    const fallbackRegex = /(\d{1,2})[.\/\-](\d{1,2})[.\/\-](20\d{2})/m;
    const m = text.match(fallbackRegex);
    if (m) {
      const day = m[1].padStart(2, '0');
      const month = m[2].padStart(2, '0');
      result.date = `${m[3]}-${month}-${day}`;
    }
  }

  // 3. Сума в EUR
  const amountRegexes = [
    // Multiline: ОБЩА СУМА \n EBPO/EUR/ЕВРО \n 51.10
    /обща\s*сума\s+(?:евро|eur|ebpo)\s+€?\s*([0-9]+[.,][0-9]{2})/is,
    /обща\s*сума\s*(?:евро|eur|ebpo)[:\s]*€?\s*([0-9]+[.,][0-9]{2})/i,
    /total\s*EUR[:\s]*€?\s*([0-9]+[.,][0-9]{2})/i,
    /с\s*дебитна\s*карта[:\s]*€?\s*([0-9]+[.,][0-9]{2})/i,
    /кредитна[\/\s]*дебитна\s*карта[:\s]*€?\s*([0-9]+[.,][0-9]{2})/i,
    /обща\s*сума[:\s]*€?\s*([0-9]+[.,][0-9]{2})/i
  ];
  for (const re of amountRegexes) {
    const m = text.match(re);
    if (m) { result.amount = parseFloat(m[1].replace(',', '.')); break; }
  }

  // "Сума за плащане": Vision често подрежда итоговия блок по колони — първо
  // етикетите (основа / ДДС / за плащане), после сумите. Затова числото веднага
  // след етикета може да е ДДС-то. Взимаме НАЙ-ГОЛЯМАТА сума в евро от блока:
  // сумата за плащане винаги е ≥ данъчната основа и ДДС.
  if (!result.amount) {
    result.amount = largestAmountAfter(text, /за\s*плащане/i);
  }

  // Fallback: ако не намерим, взимай ПОСЛЕДНОТО € число (обикновено е общата сума)
  if (!result.amount) {
    const allEur = [...text.matchAll(/€\s*([0-9]+[.,][0-9]{2})/g)];
    if (allEur.length) {
      result.amount = parseFloat(allEur[allEur.length - 1][1].replace(',', '.'));
    }
  }

  // 4. Сума без ДДС
  const noVatRegexes = [
    /нето\s*ст[\-\s]*ст[:\s]*([0-9]+[.,][0-9]{2})/i,
    /нето\s*стойност[:\s]*([0-9]+[.,][0-9]{2})/i,
    /сума\s*без\s*ддс[:\s]*([0-9]+[.,][0-9]{2})/i,
    /данъчна\s*основа[:\s]*([0-9]+[.,][0-9]{2})/i,
    /без\s*ддс[:\s]*([0-9]+[.,][0-9]{2})/i
  ];
  for (const re of noVatRegexes) {
    const m = text.match(re);
    if (m) { result.amount_no_vat = parseFloat(m[1].replace(',', '.')); break; }
  }

  // 5. Контрагент
  //    "кофи брадърс / coffee brothers" — това сме ние (Получател), никога не е контрагент
  const skipKeywords = /(пос\s*терминал|оригинал|копие|адрес|клиент|данни|каса|транзак|получател|купувач|идент|здас|еик|ддс|метанстанция|метастанция|колонка|шофьор|продавач|титуляр|банка|bic|iban|място|клон|НАП|номер|телефон|email|свежест|стара|общ|улица|ул\.|гр\.|с\.|плащане|словом|пълномощно|подпис|печат|съставил|дата|мярка|колич|цена|стойност|всичко|общо|основание|данъкът|обстоятелствата|сума|бр\b|кг\b|кофи\s*брад|coffee\s*brothers)/i;
  const corpForms = /(?<![а-яА-Я])(ЕООД|ЕГОД|ЕОД|ООО|ООД|ЕАД|АД|ЕТ|EOOD|OOD|LTD)(?![а-яА-Я])/;

  // ПРИОРИТЕТ 1: Намери текст след "издател:" - стандартна фактура
  const issuerIdx = text.toLowerCase().indexOf('издател');
  if (issuerIdx >= 0) {
    const textAfter = text.substring(issuerIdx);
    const linesAfter = textAfter.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < Math.min(linesAfter.length, 30); i++) {
      const line = linesAfter[i];
      if (skipKeywords.test(line)) continue;
      if (line.startsWith('BG') || /^\d+$/.test(line)) continue;  // ЕИК
      if (!corpForms.test(line)) continue;
      // Намерихме ред с правна форма
      // Ако е къс (< 20 символа), вероятно е продължение на предишен ред
      if (line.length < 20 && i > 0) {
        const prev = linesAfter[i-1];
        if (!skipKeywords.test(prev) && prev.length < 60 && !prev.startsWith('BG') && !/^\d+$/.test(prev)) {
          result.contractor = (prev + ' ' + line).replace(/["'']/g, '').trim().substring(0, 100);
          break;
        }
      }
      result.contractor = line.replace(/["'']/g, '').trim().substring(0, 100);
      break;
    }
  }

  // ПРИОРИТЕТ 2: "Доставчик" — фактура с кутии Получател / Доставчик.
  // Името е на същия ред след етикета или на следващия ред.
  if (!result.contractor) {
    const i = lines.findIndex(l => /доставчик/i.test(l));
    if (i >= 0) {
      const after = lines[i].replace(/^.*доставчик[:\s]*/i, '');
      const next = lines[i + 1] || '';
      let cand = '';
      if (corpForms.test(after) && !skipKeywords.test(after)) cand = after;
      else if (corpForms.test(next) && !skipKeywords.test(next)) cand = next;
      if (cand) result.contractor = cand.replace(/["'']/g, '').trim().substring(0, 100);
    }
  }

  // Опит 1 — първите 5 реда (само ако приоритетите по етикет не са намерили нищо)
  if (!result.contractor) {
    for (const line of lines.slice(0, 5)) {
      if (skipKeywords.test(line)) continue;
      if (line.length < 4 || line.length > 100) continue;
      if (corpForms.test(line)) {
        // Почисти кавички
        let cleaned = line.replace(/["'']/g, '').trim();
        result.contractor = cleaned.substring(0, 100);
        break;
      }
    }
  }

  // Опит 2 — навсякъде
  if (!result.contractor) {
    for (const line of lines) {
      if (skipKeywords.test(line)) continue;
      if (line.length < 4 || line.length > 100) continue;
      if (corpForms.test(line)) {
        let cleaned = line.replace(/["'']/g, '').trim();
        result.contractor = cleaned.substring(0, 100);
        break;
      }
    }
  }

  return result;
}

// Най-голямата сума (в евро, ако има маркирани с €/EUR/евро) в блока след етикета.
// Блокът спира до "Словом" / IBAN / "Дата на данъчно събитие" или до 250 знака.
// Дати (17.11.2026) и суми в лева се пропускат.
function largestAmountAfter(text: string, label: RegExp): number | null {
  const m = label.exec(text);
  if (!m) return null;
  let win = text.slice(m.index, m.index + 250);
  const stop = win.search(/словом|iban|дата\s*на\s*данъчно/i);
  if (stop > 0) win = win.slice(0, stop);
  const eur: number[] = [], plain: number[] = [];
  const re = /(?<![\d.,])((?:\d{1,3}(?:[  ]\d{3})+|\d+)[.,]\d{2})(?!\d|[.,]\d)\s*(€|eur|евро|лв|bgn)?/gi;
  for (const a of win.matchAll(re)) {
    const cur = (a[2] || '').toLowerCase();
    if (cur === 'лв' || cur === 'bgn') continue;
    const v = parseFloat(a[1].replace(/[  ]/g, '').replace(',', '.'));
    (cur ? eur : plain).push(v);
  }
  const pool = eur.length ? eur : plain;
  return pool.length ? Math.max(...pool) : null;
}
