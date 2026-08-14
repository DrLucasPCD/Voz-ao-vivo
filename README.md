# Clara — Voz ao vivo

Aplicativo web de comunicação assistida para ajudar um médico com alteração de
dicção a conduzir consultas. A Clara reconhece a fala, permite corrigir a
pergunta e a reproduz com voz clara para o paciente.

## Recursos

- reconhecimento de fala em português do Brasil;
- reprodução da pergunta com síntese de voz;
- perguntas rápidas de anamnese;
- treinamento organizado por etapas da consulta médica;
- memória local das correções do usuário, mesmo sem login;
- sincronização opcional entre dispositivos com login Google;
- áudios privados no Firebase Storage e metadados no Firestore;
- gravação de áudio associada ao texto correto;
- exportação da base de voz em ZIP;
- interface responsiva e acessível.

Sem login, as correções e gravações ficam somente no navegador. Ao entrar com
Google, o perfil é sincronizado no projeto Firebase `voz-ao-vivo`, em caminhos
isolados pelo identificador da conta.

## Executar localmente

Requer Node.js 22 ou mais recente.

```bash
npm install
npm run dev
```

Abra `http://localhost:3000` no Chrome ou Edge e permita o acesso ao microfone.

## Verificação

```bash
npm run lint
npm test
```

## Hospedar no Netlify

O projeto usa Next.js e inclui o arquivo `netlify.toml`. No Netlify:

1. Selecione **Add new project → Import an existing project**.
2. Conecte o repositório `DrLucasPCD/Voz-ao-vivo`.
3. Confirme o comando de build `npm run build` e a pasta `.next`.
4. Publique o projeto.

O Netlify detecta o Next.js automaticamente. Não é necessário fixar uma versão
do adaptador do Netlify.

## Ativar a sincronização Firebase

A configuração pública do app Firebase já está no código. Antes de usar a
sincronização em produção, faça estas etapas no [Console do Firebase](https://console.firebase.google.com/):

1. Em **Authentication → Sign-in method**, ative o provedor **Google**.
2. Crie o banco **Cloud Firestore** e o **Cloud Storage** no projeto
   `voz-ao-vivo`.
3. Em **Authentication → Settings → Authorized domains**, adicione o domínio
   final do site no Netlify, sem `https://`.
4. Instale a CLI e publique as regras privadas incluídas no repositório:

```bash
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules,storage
```

As regras permitem que cada usuário autenticado acesse apenas
`users/{seu-uid}/...`. Não publique o banco ou o Storage com regras abertas de
modo de teste. Para produção, também é recomendável ativar o Firebase App Check.

O Analytics não é inicializado neste app, para evitar telemetria desnecessária
em um fluxo com dados de voz potencialmente sensíveis.

## Privacidade clínica

Este protótipo é uma ferramenta de comunicação e não fornece diagnóstico ou
conduta médica. Evite incluir dados identificáveis do paciente nas frases de
treinamento. Em uso clínico, valide os requisitos de privacidade, segurança e
conformidade aplicáveis à sua instituição. Firebase e Netlify, isoladamente,
não garantem conformidade regulatória para dados clínicos.
