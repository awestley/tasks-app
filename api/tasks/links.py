"""Links from tasks and projects to items in other apps. Finding what links to an item, and resolving one of
this app's refs, are part of the app contract (contract.py)."""

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import authenticate
from .db import Link, Project, Task, get_db
from .refs import parse_ref, ref_from_url, url_for
from .schemas import LinkIn, LinkOut

router = APIRouter(prefix="/api/v1", tags=["Links"])
MAX_LINKS = 50
OWNERS = {"task": Task, "project": Project}


def owner(db, kind, owner_id, user):
    model = OWNERS[kind]
    found = db.scalar(select(model).where(model.id == owner_id, model.user_id == user.id))
    if not found:
        raise HTTPException(404, "Resource not found")
    return found


def links_of(db, kind, owner_id):
    return db.scalars(
        select(Link).where(Link.owner_type == kind, Link.owner_id == owner_id).order_by(Link.created_at, Link.id)
    ).all()


def remove_links(db, kind, owner_id):
    db.execute(delete(Link).where(Link.owner_type == kind, Link.owner_id == owner_id))


def copy_links(db, user_id, source_id, target_id):
    """A recurring task's next occurrence keeps the notes and pages the series points at."""
    for link in links_of(db, "task", source_id):
        db.add(
            Link(user_id=user_id, owner_type="task", owner_id=target_id, ref=link.ref, title=link.title, url=link.url)
        )


def add_link(db, kind, owner_id, data: LinkIn, user, response: Response):
    owner(db, kind, owner_id, user)
    ref = data.ref or ref_from_url(data.url)
    url = data.url or url_for(ref)
    title = data.title or (parse_ref(ref)[1].capitalize() if ref else url)
    if ref:
        existing = db.scalar(select(Link).where(Link.owner_type == kind, Link.owner_id == owner_id, Link.ref == ref))
        if existing:
            # Adding the same item again refreshes its title and address instead of failing.
            existing.title, existing.url = (data.title or existing.title), (url or existing.url)
            db.commit()
            response.status_code = 200
            return existing
    if len(links_of(db, kind, owner_id)) >= MAX_LINKS:
        raise HTTPException(422, f"A {kind} can have at most {MAX_LINKS} links")
    link = Link(user_id=user.id, owner_type=kind, owner_id=owner_id, ref=ref, title=title[:200], url=url)
    db.add(link)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(409, "This link was just added. Refresh and try again.") from error
    return link


def drop_link(db, kind, owner_id, link_id, user):
    owner(db, kind, owner_id, user)
    result = db.execute(
        delete(Link).where(
            Link.id == link_id, Link.owner_type == kind, Link.owner_id == owner_id, Link.user_id == user.id
        )
    )
    if result.rowcount != 1:
        raise HTTPException(404, "Resource not found")
    db.commit()


@router.get("/tasks/{task_id}/links", response_model=list[LinkOut])
def task_links(task_id: str, user=Depends(authenticate), db: Session = Depends(get_db)):
    owner(db, "task", task_id, user)
    return links_of(db, "task", task_id)


@router.post("/tasks/{task_id}/links", response_model=LinkOut, status_code=201)
def link_task(
    task_id: str, data: LinkIn, response: Response, user=Depends(authenticate), db: Session = Depends(get_db)
):
    """Link a task to a pc:// reference or a web address. Linking the same reference again updates it."""
    return add_link(db, "task", task_id, data, user, response)


@router.delete("/tasks/{task_id}/links/{link_id}", status_code=204)
def unlink_task(task_id: str, link_id: str, user=Depends(authenticate), db: Session = Depends(get_db)):
    drop_link(db, "task", task_id, link_id, user)


@router.get("/projects/{project_id}/links", response_model=list[LinkOut])
def project_links(project_id: str, user=Depends(authenticate), db: Session = Depends(get_db)):
    owner(db, "project", project_id, user)
    return links_of(db, "project", project_id)


@router.post("/projects/{project_id}/links", response_model=LinkOut, status_code=201)
def link_project(
    project_id: str, data: LinkIn, response: Response, user=Depends(authenticate), db: Session = Depends(get_db)
):
    return add_link(db, "project", project_id, data, user, response)


@router.delete("/projects/{project_id}/links/{link_id}", status_code=204)
def unlink_project(project_id: str, link_id: str, user=Depends(authenticate), db: Session = Depends(get_db)):
    drop_link(db, "project", project_id, link_id, user)
