# Guía de Contribución: Cómo hacer un Fork del Proyecto

¡Gracias por tu interés en contribuir a este proyecto! Para comenzar a trabajar en tus propias modificaciones, debes crear una bifurcación (*fork*) del repositorio. A continuación, te explicamos el proceso paso a paso.

---

## 1. ¿Qué es un Fork?

Un *fork* es una copia personal de este repositorio que se almacena en tu cuenta de GitHub. Te permite experimentar libremente con cambios (como corregir errores o añadir nuevas funcionalidades) sin afectar el proyecto original.

---

## 2. Pasos para hacer un Fork y configurar tu Entorno

### Paso 1: Crear el Fork en GitHub
1. Dirígete a la página principal de este repositorio en GitHub.
2. En la esquina superior derecha de la página, haz clic en el botón **Fork**.
3. Selecciona la cuenta personal o la organización de GitHub donde deseas guardar el fork.
4. *(Opcional)* Puedes cambiar el nombre o mantener el original. Asegúrate de dejar seleccionada la opción para copiar únicamente la rama principal (`main`/`master`) si solo requieres trabajar en ella, o desmarcarla si necesitas conservar todas las ramas.
5. Haz clic en el botón **Create fork**.

### Paso 2: Clonar tu Fork localmente
Una vez creado el fork en tu perfil, clónalo en tu computadora local ejecutando el siguiente comando en tu terminal:

```bash
git clone https://github.com/TU_USUARIO/NOMBRE-DEL-REPOSITORIO.git
```
> [!NOTE]  
> Asegúrate de reemplazar `TU_USUARIO` con tu nombre de usuario de GitHub y `NOMBRE-DEL-REPOSITORIO` con el nombre del proyecto.

Accede al directorio del proyecto clonado:
```bash
cd NOMBRE-DEL-REPOSITORIO
```

### Paso 3: Configurar el Repositorio Original como Remoto (Upstream)
Para mantener tu fork actualizado con los últimos desarrollos y evitar conflictos al fusionar tu código, debes vincular el repositorio original como un control remoto adicional llamado `upstream`:

```bash
git remote add upstream https://github.com/PROPIETARIO-ORIGINAL/NOMBRE-DEL-REPOSITORIO.git
```
> [!NOTE]  
> Reemplaza `PROPIETARIO-ORIGINAL` y `NOMBRE-DEL-REPOSITORIO` con los datos del repositorio original desde donde hiciste el fork.

Para verificar que los remotos se configuraron correctamente, ejecuta:
```bash
git remote -v
```
Deberías ver una salida similar a esta:
```text
origin    https://github.com/TU_USUARIO/NOMBRE-DEL-REPOSITORIO.git (fetch)
origin    https://github.com/TU_USUARIO/NOMBRE-DEL-REPOSITORIO.git (push)
upstream  https://github.com/PROPIETARIO-ORIGINAL/NOMBRE-DEL-REPOSITORIO.git (fetch)
upstream  https://github.com/PROPIETARIO-ORIGINAL/NOMBRE-DEL-REPOSITORIO.git (push)
```

---

## 3. Flujo de Trabajo para Contribuir

Sigue esta guía paso a paso cada vez que vayas a realizar una nueva contribución:

### 1. Sincronizar tu Fork con el Repositorio Original
Antes de crear una nueva rama de trabajo, es sumamente importante que incorpores las últimas actualizaciones del repositorio original a tu copia local:

```bash
# Asegúrate de estar en tu rama principal local
git checkout main

# Descarga los cambios más recientes del repositorio original (upstream)
git fetch upstream

# Fusiona los cambios descargados en tu rama local principal
git merge upstream/main

# Sube los cambios actualizados a tu fork en GitHub (origin)
git push origin main
```

### 2. Crear una nueva Rama (Branch)
Trabaja siempre en una rama dedicada para la funcionalidad, mejora o corrección que planeas realizar. Evita hacer commits directamente sobre la rama `main`:

```bash
git checkout -b mi-nueva-contribucion
```
*(Elige un nombre descriptivo y en minúsculas para tu rama, por ejemplo: `fix-login-error` o `feat-dark-mode`)*

### 3. Realizar y Confirmar Cambios
Realiza las modificaciones deseadas en el código. Para guardar el avance de tus cambios:

```bash
# Verifica qué archivos han sido modificados o agregados
git status

# Añade los archivos correspondientes al área de preparación (staging)
git add archivo_modificado.js

# Registra tus cambios con un mensaje de commit descriptivo
git commit -m "feat: descripción concisa y clara del cambio aportado"
```

### 4. Subir la Rama a tu Fork
Envía tu rama de trabajo con tus nuevos commits a tu repositorio remoto en GitHub:

```bash
git push origin mi-nueva-contribucion
```

### 5. Crear un Pull Request (PR)
1. Abre tu navegador y ve a tu fork en GitHub (`https://github.com/TU_USUARIO/NOMBRE-DEL-REPOSITORIO`).
2. Verás un banner superior de color amarillo que te indica que has subido una nueva rama. Haz clic en el botón **Compare & pull request**.
3. Si el banner no aparece, dirígete a la pestaña **Pull requests** en el repositorio original y haz clic en **New pull request**. Luego, selecciona la opción *"compare across forks"* para enlazar tu fork y la rama específica.
4. Escribe un título representativo y describe de forma detallada qué cambios realiza tu código, por qué son necesarios y cómo pueden probarse.
5. Haz clic en **Create pull request**.

¡Excelente trabajo! 🎉 El equipo de mantenedores del proyecto revisará tu propuesta, aportará comentarios si es necesario y, una vez aprobada, la fusionará con la rama principal del proyecto original.

---

## Recursos Adicionales

* [Documentación Oficial de GitHub: Trabajar con Forks](https://docs.github.com/es/pull-requests/collaborating-with-pull-requests/working-with-forks)
* [Documentación Oficial de GitHub: Sincronizar un Fork](https://docs.github.com/es/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork)
* [Guía interactiva para resolver conflictos de fusión (merge conflicts)](https://docs.github.com/es/pull-requests/collaborating-with-pull-requests/addressing-merge-conflicts)

---
*¡Feliz código!* 🚀
