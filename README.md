# Clara — Voz ao vivo

Aplicativo web de comunicação assistida para ajudar um médico com alteração de
dicção a conduzir consultas. A Clara reconhece a fala, permite corrigir a
pergunta e a reproduz com voz clara para o paciente.

## Recursos

- reconhecimento de fala em português do Brasil;
- reprodução da pergunta com síntese de voz;
- perguntas rápidas de anamnese;
- biblioteca de perguntas organizada por dezenas de especialidades;
- contexto da especialidade aplicado ao reconhecimento de voz;
- análise de até cinco alternativas de transcrição quando disponíveis;
- contextualização nativa de termos em navegadores compatíveis;
- reconhecimento em nuvem opcional com referência pessoal de voz;
- vocabulário clínico e correções pessoais enviados ao modelo de transcrição;
- retorno automático ao reconhecimento do navegador se a nuvem falhar;
- memória local das correções do usuário, mesmo sem login;
- sincronização opcional entre dispositivos com login Google ou Apple;
- áudios privados no Firebase Storage e metadados no Firestore;
- gravação de áudio associada ao texto correto;
- exportação da base de voz em ZIP;
- interface responsiva e acessível.

Sem login, as correções e gravações ficam somente no navegador. Ao entrar com
Google ou Apple, o perfil é sincronizado no projeto Firebase `voz-ao-vivo`, em
caminhos isolados pelo identificador da conta.

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

### Ativar o reconhecimento personalizado

Em **Site configuration → Environment variables** no Netlify, configure:

```text
OPENAI_API_KEY=sua-chave-secreta
OPENAI_TRANSCRIPTION_MODEL=gpt-transcribe
ALLOWED_FIREBASE_EMAILS=email-da-sua-conta
ALLOWED_FIREBASE_UIDS=
```

`OPENAI_API_KEY` é secreta e nunca deve começar com `NEXT_PUBLIC_`. A lista de
e-mails ou UIDs é obrigatória por segurança: sem ela, ninguém consegue consumir
os créditos da API. É possível autorizar mais de uma conta separando os valores
por vírgula.

Depois de configurar, faça um novo deploy no Netlify. Entre na sua conta no
app, grave pelo menos uma frase com duração entre 2 e 10 segundos e ative
**Reconhecimento personalizado na nuvem**. A função protegida em
`netlify/functions/transcribe.ts` valida a sessão Firebase antes de chamar a
API de transcrição.

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

### Login no celular com Google

No celular, o app usa diretamente o redirecionamento recomendado pelo Firebase.
Em computadores, tenta primeiro o popup e usa redirecionamento se o navegador o
bloquear. O `netlify.toml` já encaminha `/__/auth/*` ao Firebase para permitir o
fluxo no mesmo domínio.

O popup funciona com o `authDomain` padrão do Firebase e não requer configuração
adicional no Netlify. Se quiser ativar o redirecionamento no mesmo domínio, crie
no Netlify a variável `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` com apenas o domínio do
site. Adicione esse domínio aos domínios autorizados do Firebase e registre
`https://SEU-DOMINIO/__/auth/handler` como URI autorizada no cliente OAuth do
Google. Essa configuração adicional evita limitações de armazenamento de
terceiros em alguns navegadores móveis.

### Ativar login com Apple

O código do provedor Apple já está incluído, mas o botão só aparece depois da
configuração obrigatória:

1. Tenha uma assinatura ativa do **Apple Developer Program**.
2. No portal Apple Developer, crie um **Service ID**, associe o site e registre
   `https://voz-ao-vivo.firebaseapp.com/__/auth/handler` como Return URL. Crie
   também a chave privada do Sign in with Apple e anote o Team ID e o Key ID.
3. No Firebase, em **Authentication → Sign-in method → Apple**, informe o
   Service ID, Team ID, Key ID e a chave privada e ative o provedor.
4. No Netlify, defina `NEXT_PUBLIC_ENABLE_APPLE_SIGN_IN=true` e faça um novo
   deploy.

Se `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` apontar para um domínio próprio, esse
domínio e `https://SEU-DOMINIO/__/auth/handler` também precisam ser verificados
e liberados na Apple e no Firebase. Contas Apple podem ocultar o e-mail; nesse
caso, autorize a transcrição com `ALLOWED_FIREBASE_UIDS`, usando o UID mostrado
em **Firebase Authentication → Users**, em vez de depender do e-mail privado.

## Como o reconhecimento melhora

A especialidade selecionada prioriza o vocabulário clínico correspondente. O
app compara alternativas do reconhecimento, aplica as correções já ensinadas e
mantém frases que não combinam com a biblioteca como fala livre.

No modo personalizado, o app envia o áudio atual, uma referência curta da sua
voz, as correções pessoais e o vocabulário da especialidade para a transcrição
em nuvem. O resultado informa se conseguiu usar a referência de voz. Se a função
não estiver configurada ou falhar, o texto reconhecido pelo navegador é mantido.

Esse condicionamento é mais personalizado que o reconhecimento local, mas não é
um modelo acústico permanentemente treinado. Portanto, ainda não é possível
garantir 100% de acerto para toda fala.

## Privacidade clínica

Este protótipo é uma ferramenta de comunicação e não fornece diagnóstico ou
conduta médica. Evite incluir dados identificáveis do paciente nas frases de
treinamento. Em uso clínico, valide os requisitos de privacidade, segurança e
conformidade aplicáveis à sua instituição. Firebase e Netlify, isoladamente,
não garantem conformidade regulatória para dados clínicos. O modo em nuvem é
desativado por padrão e informa que o áudio será enviado à API da OpenAI; use-o
somente sem dados identificáveis de pacientes e após avaliar as políticas da
sua instituição.
