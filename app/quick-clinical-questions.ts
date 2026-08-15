import { phrasesForSpecialty } from "./clinical-phrases.ts";

export type QuickClinicalQuestion = {
  id: string;
  text: string;
  specialty: string;
  triggers: string[];
  basePriority: number;
  kind: "question" | "orientation" | "conduct";
  stage: "opening" | "history" | "review" | "exam" | "plan" | "closing";
  clinicalPath?: string;
};

const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const STOP_WORDS = new Set([
  "a", "ao", "aos", "as", "com", "da", "das", "de", "do", "dos", "e",
  "em", "essa", "esse", "esta", "este", "ha", "o", "os", "ou", "para",
  "por", "que", "se", "sem", "sua", "seu", "um", "uma", "voce",
]);

const words = (value: string) =>
  normalize(value)
    .split(" ")
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));

const SPECIALTY_TOPICS: Record<string, string[]> = {
  "Clínica geral": ["dor", "febre", "cansaço", "perda de peso", "tontura", "alteração do apetite"],
  "Urgência e emergência": ["dor intensa", "falta de ar súbita", "perda de consciência", "sangramento", "fraqueza de um lado", "trauma recente"],
  Cardiologia: ["dor no peito", "palpitações", "falta de ar aos esforços", "desmaio", "inchaço nas pernas", "pressão alta"],
  Pneumologia: ["falta de ar", "tosse", "catarro", "chiado no peito", "dor ao respirar", "sangue no escarro"],
  Gastroenterologia: ["dor abdominal", "náuseas", "vômitos", "diarreia", "prisão de ventre", "sangue nas fezes"],
  Neurologia: ["dor de cabeça", "fraqueza", "dormência", "convulsão", "alteração da memória", "dificuldade para caminhar"],
  Endocrinologia: ["sede excessiva", "urina frequente", "alteração de peso", "tremores", "intolerância ao calor", "feridas nos pés"],
  Nefrologia: ["redução da urina", "espuma na urina", "sangue na urina", "inchaço", "dor lombar", "pressão alta"],
  Urologia: ["dor para urinar", "jato urinário fraco", "urina frequente", "sangue na urina", "dor nos testículos", "disfunção erétil"],
  Infectologia: ["febre", "calafrios", "suor noturno", "diarreia", "manchas na pele", "contato com pessoa doente"],
  Reumatologia: ["dor articular", "rigidez pela manhã", "inchaço nas articulações", "fraqueza muscular", "boca seca", "manchas após sol"],
  Dermatologia: ["coceira", "mancha na pele", "ferida", "queda de cabelo", "alteração nas unhas", "pinta que mudou"],
  Hematologia: ["cansaço", "palidez", "sangramento", "manchas roxas", "infecções frequentes", "gânglios aumentados"],
  Oncologia: ["perda de peso", "dor persistente", "caroço", "sangramento", "cansaço", "efeito do tratamento"],
  "Ortopedia e traumatologia": ["dor óssea", "dor articular", "trauma", "inchaço", "limitação de movimento", "dificuldade para caminhar"],
  Ginecologia: ["dor pélvica", "sangramento vaginal", "corrimento", "coceira genital", "menstruação irregular", "dor na relação"],
  Obstetrícia: ["movimentos do bebê", "contrações", "perda de líquido", "sangramento vaginal", "dor de cabeça", "inchaço na gestação"],
  Pediatria: ["febre na criança", "recusa alimentar", "vômitos", "diarreia", "tosse", "mudança de comportamento"],
  Neonatologia: ["dificuldade para mamar", "pele amarelada", "respiração rápida", "febre no bebê", "pouca urina", "sonolência excessiva"],
  Psiquiatria: ["humor deprimido", "ansiedade", "insônia", "crise de pânico", "pensamentos de morte", "uso de substâncias"],
  Geriatria: ["queda", "esquecimento", "perda de autonomia", "tontura", "incontinência", "uso de muitos medicamentos"],
  Otorrinolaringologia: ["dor de ouvido", "perda auditiva", "zumbido", "nariz entupido", "dor de garganta", "rouquidão"],
  Oftalmologia: ["perda visual", "dor ocular", "olho vermelho", "visão dupla", "flashes de luz", "secreção ocular"],
  "Cirurgia geral": ["dor abdominal", "caroço", "ferida cirúrgica", "vômitos", "distensão abdominal", "parada de gases e fezes"],
  Anestesiologia: ["alergia a anestésico", "náusea após anestesia", "dificuldade de intubação", "dor crônica", "apneia do sono", "reação em cirurgia anterior"],
  "Medicina de família e prevenção": ["pressão alta", "diabetes", "vacinação atrasada", "sedentarismo", "tabagismo", "dificuldade no autocuidado"],
  "Cuidados paliativos": ["dor", "falta de ar", "náusea", "ansiedade", "confusão", "necessidade de apoio familiar"],
  "Alergia e imunologia": ["urticária", "inchaço súbito", "falta de ar", "rinite", "reação a alimento", "infecções repetidas"],
  Mastologia: ["caroço na mama", "dor na mama", "secreção no mamilo", "retração da pele", "vermelhidão na mama", "alteração no mamilo"],
  "Cirurgia vascular": ["inchaço na perna", "dor ao caminhar", "varizes", "ferida na perna", "pé frio", "histórico de trombose"],
  Proctologia: ["sangue nas fezes", "dor anal", "coceira anal", "caroço anal", "prisão de ventre", "mudança nas fezes"],
  "Medicina do trabalho": ["dor relacionada ao trabalho", "movimento repetitivo", "exposição a ruído", "exposição a poeira", "acidente de trabalho", "estresse ocupacional"],
  "Sexologia e saúde sexual": ["dor na relação", "redução do desejo", "dificuldade de ereção", "dificuldade de orgasmo", "risco de infecção sexual", "segurança na relação"],
};

const TOPIC_TEMPLATES = [
  "Há quanto tempo você percebe {topic}?",
  "O início de {topic} foi súbito ou gradual?",
  "Com que frequência você percebe {topic}?",
  "De zero a dez, quanto esse quadro de {topic} incomoda você?",
  "Existe algo que melhora {topic}?",
  "Existe algo que piora {topic}?",
  "Você percebe {topic} em repouso ou durante alguma atividade?",
  "De que forma o quadro de {topic} interfere nas atividades diárias?",
  "Você já teve {topic} antes?",
  "Você usa algum medicamento ou tratamento por causa de {topic}?",
  "Além de {topic}, que outros sintomas você percebeu?",
];

const SUPPORT_ACTIONS = [
  { text: "Agora vou conferir seus sinais vitais.", kind: "conduct", stage: "exam" },
  { text: "Agora vou realizar o exame físico relacionado à sua queixa.", kind: "conduct", stage: "exam" },
  { text: "Vou revisar seus medicamentos e alergias antes de definir o plano.", kind: "conduct", stage: "history" },
  { text: "Vou organizar os problemas encontrados e discutir as hipóteses com a preceptoria.", kind: "conduct", stage: "plan" },
  { text: "Pode ser necessário solicitar exames; primeiro vou concluir a avaliação clínica.", kind: "conduct", stage: "plan" },
  { text: "Vou confirmar com a preceptoria a conduta mais segura para o seu caso.", kind: "conduct", stage: "plan" },
  { text: "Vou registrar as orientações e combinar quando você deve retornar.", kind: "conduct", stage: "closing" },
  { text: "Não interrompa nem altere seus medicamentos sem orientação da equipe responsável.", kind: "orientation", stage: "closing" },
  { text: "Se houver piora importante ou um sintoma novo intenso, procure atendimento imediatamente.", kind: "orientation", stage: "closing" },
  { text: "É importante trazer sua lista de medicamentos e seus exames no próximo atendimento.", kind: "orientation", stage: "closing" },
  { text: "Anote quando os sintomas aparecem e o que parece melhorar ou piorar o quadro.", kind: "orientation", stage: "closing" },
  { text: "Vou explicar o plano em etapas e você pode me interromper se tiver alguma dúvida.", kind: "orientation", stage: "plan" },
] as const;

const GENERAL_CLINICAL_PATHS = [
  {
    name: "Dor torácica e cardiovascular",
    triggers: ["dor no peito", "peito", "palpitação", "desmaio", "inchaço"],
    questions: [
      "A dor começou de repente ou foi aumentando aos poucos?",
      "A dor se espalha para braço, costas, pescoço ou mandíbula?",
      "A dor aparece no esforço e melhora com repouso?",
      "Junto com a dor, houve falta de ar, suor frio, náusea ou desmaio?",
    ],
  },
  {
    name: "Dispneia e respiratório",
    triggers: ["falta de ar", "sem ar", "respirar", "tosse", "chiado", "cansaço"],
    questions: [
      "A falta de ar acontece em repouso ou somente aos esforços?",
      "Você precisa de mais travesseiros ou acorda à noite com falta de ar?",
      "Há tosse, catarro, chiado, febre ou dor para respirar?",
      "A falta de ar começou de forma súbita?",
    ],
  },
  {
    name: "Dor abdominal e digestivo",
    triggers: ["dor abdominal", "barriga", "vômito", "diarreia", "fezes"],
    questions: [
      "Onde exatamente começou a dor e para onde ela se espalha?",
      "A dor tem relação com alimentação, evacuação ou movimento?",
      "Houve vômitos, diarreia, prisão de ventre ou sangue nas fezes?",
      "Você parou de eliminar gases ou percebeu aumento do abdome?",
    ],
  },
  {
    name: "Neurológico",
    triggers: ["dor de cabeça", "fraqueza", "dormência", "tontura", "convulsão", "fala"],
    questions: [
      "O sintoma começou de repente e atingiu a maior intensidade logo no início?",
      "Houve fraqueza ou dormência de um lado, alteração da fala ou da visão?",
      "Houve desmaio, confusão, convulsão ou dificuldade para caminhar?",
      "Existe febre, rigidez no pescoço ou trauma recente?",
    ],
  },
  {
    name: "Febre e síndrome infecciosa",
    triggers: ["febre", "calafrio", "infecção", "suor", "contato"],
    questions: [
      "Qual foi a maior temperatura medida e há quantos dias começou?",
      "Há calafrios, suor noturno, manchas na pele ou perda de peso?",
      "Teve contato com pessoa doente, viagem recente ou exposição a animais?",
      "Há algum foco de dor, tosse, diarreia ou ardor para urinar?",
    ],
  },
  {
    name: "Urinário e renal",
    triggers: ["urina", "urinar", "ardor", "lombar", "rim"],
    questions: [
      "Há ardor, urgência ou aumento da frequência para urinar?",
      "Percebeu sangue, espuma, alteração da cor ou redução da urina?",
      "Existe febre, calafrio ou dor nas costas perto dos rins?",
      "Há corrimento, dor pélvica ou possibilidade de gestação?",
    ],
  },
  {
    name: "Saúde mental e risco",
    triggers: ["triste", "ansiedade", "pânico", "sono", "morrer", "suicídio"],
    questions: [
      "Como seu humor e seu sono mudaram nas últimas duas semanas?",
      "Você perdeu o interesse ou o prazer nas atividades habituais?",
      "Pensou em se machucar, em morrer ou chegou a planejar algo?",
      "Você se sente seguro agora e tem alguém de confiança por perto?",
    ],
  },
] as const;

const CONTEXT_RULES = [
  { heard: ["dor"], prioritize: ["zero", "inicio", "súbito", "melhorar", "piorar", "espalha", "local"] },
  { heard: ["febre", "calafrio"], prioritize: ["febre", "temperatura", "calafrio", "infecção", "contato"] },
  { heard: ["falta", "sem ar", "respirar", "cansado"], prioritize: ["falta de ar", "respirar", "repouso", "esforço", "deitar", "travesseiro"] },
  { heard: ["sangue", "sangramento"], prioritize: ["sangue", "sangramento", "quantidade", "tontura", "desmaio"] },
  { heard: ["remedio", "medicamento"], prioritize: ["medicamento", "dose", "horário", "alergia", "tratamento"] },
  { heard: ["caiu", "queda", "trauma", "acidente"], prioritize: ["queda", "trauma", "acidente", "consciência", "pancada"] },
  { heard: ["triste", "morrer", "suicidio"], prioritize: ["morte", "machucar", "segurança", "apoio", "humor"] },
];

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function createQuestion(
  specialty: string,
  text: string,
  basePriority: number,
  extraTriggers: string[] = [],
  kind: QuickClinicalQuestion["kind"] = "question",
  stage: QuickClinicalQuestion["stage"] = "history",
  clinicalPath?: string,
): QuickClinicalQuestion {
  return {
    id: `${normalize(specialty)}-${normalize(text)}`,
    text,
    specialty,
    triggers: Array.from(new Set([...words(text), ...extraTriggers.flatMap(words)])),
    basePriority,
    kind,
    stage,
    clinicalPath,
  };
}

export function quickQuestionsForSpecialty(specialty: string) {
  const questions: QuickClinicalQuestion[] = [];
  const seen = new Set<string>();
  const add = (question: QuickClinicalQuestion) => {
    const key = normalize(question.text);
    if (seen.has(key)) return;
    seen.add(key);
    questions.push(question);
  };

  phrasesForSpecialty(specialty).forEach((phrase, index) =>
    add(createQuestion(specialty, phrase.text, 300 - index, [], "question", index < 4 ? "opening" : "history")),
  );

  (SPECIALTY_TOPICS[specialty] ?? SPECIALTY_TOPICS["Clínica geral"]).forEach(
    (topic, topicIndex) => {
      TOPIC_TEMPLATES.forEach((template, templateIndex) => {
        const text = template
          .replace("{Topic}", capitalize(topic))
          .replace("{topic}", topic);
        add(
          createQuestion(
            specialty,
            text,
            220 - topicIndex * 8 - templateIndex,
            [topic],
          ),
        );
      });
    },
  );

  phrasesForSpecialty("Clínica geral").forEach((phrase, index) =>
    add(createQuestion(specialty, phrase.text, 100 - index)),
  );

  SUPPORT_ACTIONS.forEach((action, index) =>
    add(
      createQuestion(
        specialty,
        action.text,
        145 - index,
        [specialty],
        action.kind,
        action.stage,
      ),
    ),
  );

  if (specialty === "Clínica geral") {
    GENERAL_CLINICAL_PATHS.forEach((path, pathIndex) => {
      path.questions.forEach((text, questionIndex) =>
        add(
          createQuestion(
            specialty,
            text,
            185 - pathIndex * 3 - questionIndex,
            [...path.triggers],
            "question",
            questionIndex < 3 ? "history" : "review",
            path.name,
          ),
        ),
      );
    });
  }

  return questions;
}

export function prioritizeQuickQuestions(
  specialty: string,
  patientContext: string,
  usedTexts: string[] = [],
) {
  const contextTokens = new Set(words(patientContext));
  const normalizedContext = normalize(patientContext);
  const used = new Set(usedTexts.map(normalize));
  return quickQuestionsForSpecialty(specialty)
    .filter((question) => !used.has(normalize(question.text)))
    .map((question) => {
      let score = question.basePriority;
      question.triggers.forEach((trigger) => {
        if (contextTokens.has(trigger)) score += 90;
        else if (normalizedContext.includes(trigger)) score += 35;
      });
      CONTEXT_RULES.forEach((rule) => {
        if (!rule.heard.some((term) => normalizedContext.includes(normalize(term)))) return;
        if (rule.prioritize.some((term) => normalize(question.text).includes(normalize(term)))) {
          score += 70;
        }
      });
      if (
        specialty === "Clínica geral" &&
        question.clinicalPath &&
        question.triggers.some((trigger) => normalizedContext.includes(trigger))
      ) {
        score += 220;
      }
      if (patientContext && question.stage === "opening") score -= 80;
      if (patientContext && question.kind !== "question") score += 18;
      return { ...question, score };
    })
    .sort((left, right) => right.score - left.score);
}

export function classifyNonOwnerSpeech(text: string): "patient" | "team" {
  const normalized = normalize(text);
  const patientSignals = [
    "eu sinto", "estou com", "tenho", "minha dor", "meu", "minha", "começou",
    "doi", "doendo", "não consigo", "percebi", "tomei", "vomitei", "tive",
  ];
  const teamSignals = [
    "hipótese", "diagnóstico", "conduta", "prescrever", "solicitar", "exame físico",
    "ausculta", "palpação", "anamnese", "paciente apresenta", "caso clínico",
    "o que você acha", "qual seria", "vamos discutir", "faça o exame", "avalie",
    "doutor", "preceptor", "residente", "interno", "colega",
  ];
  const symptomSignals = [
    "dor", "febre", "falta de ar", "tosse", "tontura", "náusea", "vomito",
    "sangue", "cansaço", "coceira", "inchaço", "fraqueza",
  ];

  let patientScore = patientSignals.reduce(
    (score, signal) => score + (normalized.includes(normalize(signal)) ? 2 : 0),
    0,
  );
  patientScore += symptomSignals.reduce(
    (score, signal) => score + (normalized.includes(normalize(signal)) ? 1 : 0),
    0,
  );
  const teamScore = teamSignals.reduce(
    (score, signal) => score + (normalized.includes(normalize(signal)) ? 2 : 0),
    0,
  );
  return teamScore >= Math.max(2, patientScore + 1) ? "team" : "patient";
}
