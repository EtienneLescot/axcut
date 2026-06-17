# Spécification — Timeline, clips, cuts, transcript et skips

## 1. Objectif

Réintroduire la possibilité de redimensionner manuellement les `skips` depuis la timeline, avec des poignées aux extrémités gauche et droite.

L’affichage actuel en overlay peut prêter à confusion. L’objectif est donc de revenir à une représentation plus lisible : dans la timeline, un `skip` doit apparaître comme un segment linéaire inséré entre deux portions conservées du montage, plutôt que comme une simple couche superposée.

Visuellement, lorsqu’un `skip` se trouve au milieu d’un clip, le clip doit sembler coupé en deux, avec un segment `skip` au milieu. Ce segment peut être redimensionné manuellement par l’utilisateur.

## 2. Principe général

Le système repose sur deux niveaux d’abstraction distincts :

1. **Le niveau clip / montage**

   * Gestion des sources vidéo.
   * Création de clips à partir des sources.
   * Découpage, duplication, déplacement et assemblage des clips dans la timeline.
   * Définition des bornes source de chaque clip : timestamp de début et timestamp de fin.

2. **Le niveau skip**

   * Gestion des suppressions temporaires appliquées par-dessus le montage existant.
   * Les skips ne modifient pas directement les clips.
   * Ils décrivent des portions à exclure du résultat final, au-dessus de la timeline montée.

Ces deux niveaux sont décrits dans un même DSL, qui sert de source de vérité unique.

## 3. Source de vérité : DSL / SSOT

Le DSL est la source de vérité unique du projet.

Il décrit :

* les ressources vidéo disponibles ;
* les transcripts originels associés aux vidéos sources ;
* les clips créés à partir des vidéos sources ;
* le montage des clips dans la timeline ;
* les cuts et l’ordre des clips ;
* le transcript résultant du montage, organisé par clip ;
* les éditions appliquées au transcript, notamment les skips.

Toutes les interfaces doivent lire et modifier ce même DSL :

* interface LLM ;
* timeline ;
* vue transcript ;
* panel vidéo.

Aucune interface ne doit maintenir son propre état logique indépendant. Les vues doivent simplement refléter l’état courant du DSL.

## 4. Entités principales

### 4.1 Vidéo source

Une vidéo source est un média importé dans le projet.

Elle possède :

* un fichier vidéo ;
* un transcript originel ;
* des métadonnées éventuelles : durée, nom, chemin, langue, etc.

Une vidéo source n’est pas directement montée. Elle devient exploitable dans la timeline uniquement lorsqu’elle est transformée en clip.

### 4.2 Clip

Un clip est une instance d’une vidéo source placée dans la timeline.

Lorsqu’une vidéo source est glissée dans la timeline, elle crée un clip.

Un clip contient notamment :

* une référence vers la vidéo source ;
* un timestamp de début dans la source ;
* un timestamp de fin dans la source ;
* une position dans la timeline ;
* un identifiant propre.

Un même fichier source peut donc donner naissance à plusieurs clips différents, chacun avec ses propres bornes de début et de fin.

### 4.3 Cut / montage

Le montage correspond à l’assemblage linéaire des clips dans la timeline.

L’utilisateur peut :

* déplacer les clips ;
* les réordonner ;
* les couper ;
* les dupliquer ;
* supprimer un clip ;
* coller un clip copié.

Le LLM doit pouvoir effectuer les mêmes opérations en modifiant directement le DSL.

### 4.4 Skip

Un skip est une exclusion temporaire appliquée au résultat du montage.

Un skip :

* ne modifie pas la vidéo source ;
* ne modifie pas directement les bornes du clip ;
* s’applique au-dessus de la timeline montée ;
* peut être créé depuis la timeline, le transcript ou le LLM ;
* peut être redimensionné depuis la timeline via des poignées ;
* doit être visible dans la timeline et dans le transcript ;
* doit être pris en compte dans le rendu vidéo final.

Un skip peut être situé à l’intérieur d’un clip ou traverser plusieurs clips. Dans tous les cas, il reste une entité logique distincte du clip.

## 5. Comportement de la timeline

La timeline doit afficher de manière linéaire :

* les clips ;
* les séparations entre clips ;
* les skips.

Les skips ne doivent plus être perçus comme un simple overlay ambigu. Ils doivent être représentés comme des segments intégrés visuellement dans la ligne temporelle.

### Exemple visuel attendu

Si un clip contient un skip en son milieu, la timeline doit donner l’impression suivante :

```text
[ Clip A - partie conservée ] [ Skip ] [ Clip A - partie conservée ]
```

Le skip doit disposer de poignées à gauche et à droite pour permettre son redimensionnement manuel.

### Règle importante

En mode timeline général :

* les skips sont éditables directement avec leurs poignées ;
* les clips ne sont pas raccourcis directement avec ces mêmes poignées, afin d’éviter la confusion entre édition de clip et édition de skip.

L’édition des bornes d’un clip se fait via un mode dédié.

## 6. Édition d’un clip

Chaque clip affiché dans la timeline doit proposer un bouton d’édition, par exemple un petit bouton crayon.

Lorsque l’utilisateur clique sur ce bouton, il entre dans un mode d’édition du clip.

Dans ce mode, l’utilisateur peut modifier :

* le timestamp de début du clip dans la vidéo source ;
* le timestamp de fin du clip dans la vidéo source.

Cette édition se fait via des poignées aux extrémités du clip, mais uniquement dans ce mode dédié.

Cela permet de distinguer clairement :

* le raccourcissement réel d’un clip ;
* l’ajout ou la modification d’un skip par-dessus la timeline.

## 7. Copie et duplication de clips

L’utilisateur doit pouvoir copier-coller un clip avec `Ctrl+C` / `Ctrl+V`.

Le clip collé :

* référence la même vidéo source ;
* conserve les bornes de début et de fin du clip copié ;
* possède un nouvel identifiant ;
* peut ensuite être édité indépendamment via le bouton crayon.

Cela permet de créer plusieurs extraits différents à partir d’une même vidéo source.

## 8. Vue transcript

La vue transcript affiche le transcript résultant du montage.

Elle doit être organisée par clip, afin que l’utilisateur comprenne de quelle portion de vidéo provient chaque texte.

Les portions correspondant à des skips doivent être affichées en rouge ou avec un style distinctif clair.

La vue transcript permet d’éditer les skips, mais ne permet pas d’éditer les bornes des clips.

Règle UX :

* éditer un skip depuis le transcript est autorisé ;
* éditer un clip depuis le transcript n’est pas autorisé ;
* l’édition des clips se fait uniquement depuis la timeline, via le bouton crayon du clip.

## 9. Panel vidéo

Le panel vidéo doit afficher le résultat final cumulé :

* montage des clips ;
* cuts ;
* skips.

La lecture doit être parfaitement seamless.

L’utilisateur ne doit pas percevoir les skips comme des trous techniques ou des overlays visuels. Le rendu vidéo doit simplement correspondre à la vidéo finale après application de toutes les éditions décrites dans le DSL.

## 10. Rôle du LLM

Le LLM doit manipuler le même DSL que les interfaces utilisateur.

Il peut donc :

* créer des clips ;
* modifier les bornes d’un clip ;
* couper ou réorganiser la timeline ;
* créer des skips ;
* supprimer des skips ;
* redimensionner des skips ;
* modifier le montage global.

Le LLM ne doit pas produire un état parallèle ou implicite. Toutes ses modifications doivent être représentées explicitement dans le DSL.

## 11. Règles de synchronisation

Toutes les vues doivent être synchronisées à partir du DSL.

Lorsqu’une modification est faite depuis la timeline :

* le transcript se met à jour ;
* le panel vidéo se met à jour ;
* le DSL est modifié.

Lorsqu’une modification est faite depuis le transcript :

* la timeline se met à jour ;
* le panel vidéo se met à jour ;
* le DSL est modifié.

Lorsqu’une modification est faite par le LLM :

* la timeline reflète la modification ;
* le transcript reflète la modification ;
* le panel vidéo reflète la modification ;
* le DSL reste la source de vérité.

## 12. Résumé UX

La timeline sert à manipuler le montage visuel.

Elle permet :

* d’ajouter des vidéos sources sous forme de clips ;
* de déplacer les clips ;
* de dupliquer les clips ;
* d’éditer les clips via un bouton crayon ;
* d’afficher les skips comme des segments linéaires ;
* de redimensionner les skips avec des poignées.

Le transcript sert à manipuler le texte résultant du montage.

Il permet :

* de voir le texte organisé par clip ;
* de voir clairement les parties skippées ;
* de créer ou modifier des skips ;
* mais pas de modifier les bornes des clips.

Le panel vidéo sert à prévisualiser le résultat final.

Il affiche :

* le montage ;
* les cuts ;
* les skips ;
* le tout sous forme de lecture seamless.

## 13. Décision de conception principale

Les clips et les skips doivent rester deux concepts distincts.

Un clip représente une portion de vidéo source utilisée dans la timeline.

Un skip représente une exclusion appliquée par-dessus le montage existant.

Visuellement, un skip peut donner l’impression de couper un clip en deux, mais techniquement il ne doit pas modifier directement ce clip. Il reste une édition de niveau supérieur, appliquée sur la timeline montée.

Cette distinction permet de conserver une UX simple tout en gardant une architecture propre et manipulable par le LLM.
