# StreamHub — Deploy no Render

## Por que não Netlify?

Netlify só hospeda **sites estáticos**. O StreamHub precisa de um servidor
Node.js rodando continuamente com WebSocket (Socket.io). O Netlify não
suporta isso — por isso aparece "Page not found".

O **Render** é gratuito e suporta tudo que o projeto precisa.

---

## Passo a passo: GitHub + Render

### 1. Criar conta no GitHub (se não tiver)
Acesse https://github.com e crie uma conta gratuita.

### 2. Criar repositório no GitHub
1. Clique em **"New repository"**
2. Nome: `streamhub`
3. Deixe **privado** (recomendado)
4. Clique em **"Create repository"**

### 3. Subir o código pelo GitHub Desktop ou terminal

**Pelo terminal (PowerShell):**
```powershell
cd C:\Users\bracinho\Desktop\site-transmicao
git init
git add .
git commit -m "StreamHub v1"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/streamhub.git
git push -u origin main
```
> Substitua `SEU_USUARIO` pelo seu usuário do GitHub.

### 4. Criar conta no Render
Acesse https://render.com e clique em **"Get Started for Free"**.
Faça login com sua conta do **GitHub** (mais fácil).

### 5. Criar o serviço no Render
1. No painel do Render, clique em **"New +"** → **"Web Service"**
2. Selecione **"Build and deploy from a Git repository"**
3. Conecte sua conta do GitHub se pedido
4. Selecione o repositório **streamhub**
5. Preencha:
   - **Name:** streamhub
   - **Region:** Oregon (US West) ou o mais próximo
   - **Branch:** main
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
6. Clique em **"Create Web Service"**

### 6. Aguardar o deploy
O Render vai instalar as dependências e iniciar o servidor.
Quando aparecer **"Live"** verde, o site está no ar.

### 7. Acessar o site
O Render gera um link no formato:
```
https://streamhub.onrender.com
```

---

## Observação sobre o plano gratuito do Render

No plano gratuito, o servidor **hiberna após 15 minutos sem nenhuma visita**.
Na próxima visita, ele acorda em cerca de 30-60 segundos.

Para evitar isso, você pode:
- Fazer upgrade para o plano Starter ($7/mês)
- Usar um serviço de ping como https://uptimerobot.com (gratuito)
  para fazer uma requisição a cada 10 minutos

---

## Variáveis de ambiente (opcional)

No painel do Render → seu serviço → **Environment**, adicione:
```
SESSION_SECRET = qualquer_texto_aleatorio_aqui
```

O `PORT` é definido automaticamente pelo Render, não precisa configurar.
